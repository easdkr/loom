use crate::croxy::args::{Args, InputFormat};
use serde_json::Value;

pub const MAX_STREAM_JSON_LINE_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub enum StdinEvent {
    UserMessage(String),
    ControlRequest {
        request: Value,
        request_id: Option<String>,
    },
    ControlResponse {
        response: Value,
        request_id: String,
    },
    KeepAlive,
    Eof,
    MalformedLine(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct StdinReadConfig {
    pub input_format: InputFormat,
    pub has_prompt: bool,
    pub read_prompt_from_stdin: bool,
}

impl From<&Args> for StdinReadConfig {
    fn from(args: &Args) -> Self {
        Self {
            input_format: args.input_format,
            has_prompt: args.prompt.is_some(),
            read_prompt_from_stdin: args.read_prompt_from_stdin,
        }
    }
}

pub fn parse_stdin_line(line: &str) -> Option<StdinEvent> {
    let parsed: Value = match serde_json::from_str(line) {
        Ok(parsed) => parsed,
        Err(err) => {
            return Some(StdinEvent::MalformedLine(format!(
                "Malformed stream-json input ignored: {err}"
            )));
        }
    };

    match parsed.get("type").and_then(Value::as_str) {
        Some("user") => parse_user_message(&parsed).map(StdinEvent::UserMessage),
        Some("control_request") => {
            parsed
                .get("request")
                .cloned()
                .map(|request| StdinEvent::ControlRequest {
                    request,
                    request_id: parsed
                        .get("request_id")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                })
        }
        Some("control_response") => {
            let response = parsed.get("response")?.clone();
            let request_id = parsed.get("request_id")?.as_str()?.to_string();
            Some(StdinEvent::ControlResponse {
                response,
                request_id,
            })
        }
        Some("keep_alive") => Some(StdinEvent::KeepAlive),
        _ => None,
    }
}

pub fn read_stdin_events(input: &str, config: &StdinReadConfig) -> Vec<StdinEvent> {
    match config.input_format {
        InputFormat::StreamJson => read_stream_json_events(input),
        InputFormat::Text if !config.has_prompt || config.read_prompt_from_stdin => {
            read_text_prompt_events(input)
        }
        InputFormat::Text => Vec::new(),
    }
}

fn read_text_prompt_events(input: &str) -> Vec<StdinEvent> {
    let mut events = Vec::new();
    let prompt = input.trim();
    if !prompt.is_empty() {
        events.push(StdinEvent::UserMessage(prompt.to_string()));
    }
    events.push(StdinEvent::Eof);
    events
}

fn read_stream_json_events(input: &str) -> Vec<StdinEvent> {
    let mut events = Vec::new();
    let mut saw_oversized_line = false;

    for line in input.split_inclusive('\n') {
        let complete_line = line.ends_with('\n');
        let line = if complete_line {
            &line[..line.len() - 1]
        } else {
            line
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.len() > MAX_STREAM_JSON_LINE_BYTES {
            saw_oversized_line = true;
            events.push(StdinEvent::MalformedLine(format!(
                "stream-json input line exceeded {MAX_STREAM_JSON_LINE_BYTES} bytes; ignored"
            )));
            continue;
        }
        if let Some(event) = parse_stdin_line(trimmed) {
            events.push(event);
        }
    }

    if input.len() > MAX_STREAM_JSON_LINE_BYTES && !input.contains('\n') && !saw_oversized_line {
        events.push(StdinEvent::MalformedLine(format!(
            "stream-json input line exceeded {MAX_STREAM_JSON_LINE_BYTES} bytes; closing stdin reader"
        )));
    }
    events.push(StdinEvent::Eof);
    events
}

fn parse_user_message(parsed: &Value) -> Option<String> {
    let content = parsed.get("message")?.get("content")?;
    let content = if let Some(content) = content.as_str() {
        content.to_string()
    } else if let Some(blocks) = content.as_array() {
        blocks
            .iter()
            .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect()
    } else {
        String::new()
    };

    if content.is_empty() {
        None
    } else {
        Some(content)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn text_config(has_prompt: bool, read_prompt_from_stdin: bool) -> StdinReadConfig {
        StdinReadConfig {
            input_format: InputFormat::Text,
            has_prompt,
            read_prompt_from_stdin,
        }
    }

    fn stream_config() -> StdinReadConfig {
        StdinReadConfig {
            input_format: InputFormat::StreamJson,
            has_prompt: false,
            read_prompt_from_stdin: false,
        }
    }

    #[test]
    fn parses_user_message_with_string_content() {
        let event =
            parse_stdin_line(r#"{"type":"user","message":{"role":"user","content":"hello"}}"#);

        assert_eq!(event, Some(StdinEvent::UserMessage("hello".to_string())));
    }

    #[test]
    fn parses_user_message_with_array_content_text_blocks_only() {
        let event = parse_stdin_line(
            r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"part1"},{"type":"image","data":"..."},{"type":"text","text":"part2"}]}}"#,
        );

        assert_eq!(
            event,
            Some(StdinEvent::UserMessage("part1part2".to_string()))
        );
    }

    #[test]
    fn skips_user_message_with_empty_content() {
        let event = parse_stdin_line(r#"{"type":"user","message":{"role":"user","content":""}}"#);

        assert_eq!(event, None);
    }

    #[test]
    fn routes_control_request_with_request_id() {
        let event = parse_stdin_line(
            r#"{"type":"control_request","request_id":"req-1","request":{"subtype":"interrupt"}}"#,
        );

        assert_eq!(
            event,
            Some(StdinEvent::ControlRequest {
                request: json!({"subtype": "interrupt"}),
                request_id: Some("req-1".to_string()),
            })
        );
    }

    #[test]
    fn routes_control_response_with_request_id() {
        let event = parse_stdin_line(
            r#"{"type":"control_response","request_id":"req-1","response":{"behavior":"allow","toolUseID":"t1"}}"#,
        );

        assert_eq!(
            event,
            Some(StdinEvent::ControlResponse {
                response: json!({"behavior": "allow", "toolUseID": "t1"}),
                request_id: "req-1".to_string(),
            })
        );
    }

    #[test]
    fn handles_keep_alive() {
        let event = parse_stdin_line(r#"{"type":"keep_alive"}"#);

        assert_eq!(event, Some(StdinEvent::KeepAlive));
    }

    #[test]
    fn reports_malformed_json() {
        let event = parse_stdin_line("not json at all");

        assert!(
            matches!(event, Some(StdinEvent::MalformedLine(message)) if message.contains("Malformed stream-json input ignored"))
        );
    }

    #[test]
    fn text_mode_emits_prompt_and_eof() {
        let events = read_stdin_events("hello from stdin\n", &text_config(false, false));

        assert_eq!(
            events,
            vec![
                StdinEvent::UserMessage("hello from stdin".to_string()),
                StdinEvent::Eof
            ]
        );
    }

    #[test]
    fn text_mode_emits_eof_for_empty_stdin() {
        let events = read_stdin_events("", &text_config(false, false));

        assert_eq!(events, vec![StdinEvent::Eof]);
    }

    #[test]
    fn text_mode_reads_stdin_when_dash_sentinel_is_set() {
        let events = read_stdin_events("hello from dash\n", &text_config(false, true));

        assert_eq!(
            events,
            vec![
                StdinEvent::UserMessage("hello from dash".to_string()),
                StdinEvent::Eof
            ]
        );
    }

    #[test]
    fn text_mode_ignores_stdin_when_explicit_prompt_is_present() {
        let events = read_stdin_events("ignored\n", &text_config(true, false));

        assert!(events.is_empty());
    }

    #[test]
    fn stream_json_mode_rejects_oversized_lines() {
        let input = "x".repeat(MAX_STREAM_JSON_LINE_BYTES + 1);
        let events = read_stdin_events(&input, &stream_config());

        assert!(
            events
                .iter()
                .any(|event| matches!(event, StdinEvent::MalformedLine(message) if message.starts_with("stream-json input line exceeded")))
        );
        assert!(events.contains(&StdinEvent::Eof));
    }

    #[test]
    fn stream_json_mode_parses_trailing_line_on_eof() {
        let events = read_stdin_events(
            r#"{"type":"user","message":{"role":"user","content":"last"}}"#,
            &stream_config(),
        );

        assert_eq!(
            events,
            vec![StdinEvent::UserMessage("last".to_string()), StdinEvent::Eof]
        );
    }

    #[test]
    fn stream_json_mode_parses_multiple_lines() {
        let input = concat!(
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"first\"}}\n",
            "{\"type\":\"keep_alive\"}\n",
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"second\"}}\n",
        );
        let events = read_stdin_events(input, &stream_config());

        assert_eq!(
            events,
            vec![
                StdinEvent::UserMessage("first".to_string()),
                StdinEvent::KeepAlive,
                StdinEvent::UserMessage("second".to_string()),
                StdinEvent::Eof,
            ]
        );
    }
}
