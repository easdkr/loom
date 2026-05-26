use crate::croxy::backends::{ProxyRequestInfo, SseEvent};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{self, Write};

const MAX_PREVIEW_CHARS: usize = 160;

#[derive(Debug, Clone, PartialEq)]
struct RequestState {
    text: String,
    saw_message_start: bool,
}

#[derive(Debug)]
pub struct ApiDebugLogger {
    requests: HashMap<String, RequestState>,
    include_text: bool,
    emit_to_stderr: bool,
    lines: Vec<String>,
}

impl ApiDebugLogger {
    pub fn new() -> Self {
        Self {
            requests: HashMap::new(),
            include_text: is_api_debug_text_enabled(),
            emit_to_stderr: true,
            lines: Vec::new(),
        }
    }

    pub fn with_include_text(include_text: bool) -> Self {
        Self {
            requests: HashMap::new(),
            include_text,
            emit_to_stderr: false,
            lines: Vec::new(),
        }
    }

    pub fn on_request_body(&mut self, body: &Value, path: &str, info: &ProxyRequestInfo) {
        self.requests.insert(
            info.request_id.clone(),
            RequestState {
                text: String::new(),
                saw_message_start: false,
            },
        );
        self.write_json(json!({
            "kind": "api_request",
            "request_id": info.request_id,
            "path": path,
            "observed": info.observe,
            "model": string_value(body.get("model")),
            "max_tokens": number_value(body.get("max_tokens")),
            "messages": body.get("messages").and_then(Value::as_array).map(Vec::len),
            "system_blocks": system_blocks(body.get("system")),
            "tools": body.get("tools").and_then(Value::as_array).map(Vec::len).unwrap_or_default(),
            "output_config": summarize_output_config(body.get("output_config")),
            "system_text": summarize_text(&extract_text(body.get("system")), self.include_text),
            "first_user_text": summarize_text(&first_user_text(body.get("messages")), self.include_text),
        }));
    }

    pub fn on_sse_event(&mut self, event: &SseEvent, info: &ProxyRequestInfo) {
        let Some(state) = self.requests.get_mut(&info.request_id) else {
            return;
        };
        let Some(parsed) = event.parsed.as_ref() else {
            return;
        };
        match parsed.get("type").and_then(Value::as_str) {
            Some("message_start") => {
                state.saw_message_start = true;
            }
            Some("content_block_delta") => {
                if parsed
                    .get("delta")
                    .and_then(|delta| delta.get("type"))
                    .and_then(Value::as_str)
                    == Some("text_delta")
                    && let Some(text) = parsed
                        .get("delta")
                        .and_then(|delta| delta.get("text"))
                        .and_then(Value::as_str)
                {
                    state.text = append_preview(&state.text, text);
                }
            }
            Some("message_stop") => {
                let state = self
                    .requests
                    .remove(&info.request_id)
                    .expect("state exists while processing message_stop");
                self.write_json(json!({
                    "kind": "api_response",
                    "request_id": info.request_id,
                    "observed": info.observe,
                    "saw_message_start": state.saw_message_start,
                    "assistant_text": summarize_text(&state.text, self.include_text),
                }));
            }
            _ => {}
        }
    }

    pub fn take_lines(&mut self) -> Vec<String> {
        std::mem::take(&mut self.lines)
    }

    fn write_json(&mut self, value: Value) {
        let line = format!("[croxy-api] {value}");
        self.lines.push(line.clone());
        if self.emit_to_stderr {
            let _ = writeln!(io::stderr(), "{line}");
        }
    }
}

impl Default for ApiDebugLogger {
    fn default() -> Self {
        Self::new()
    }
}

pub fn is_api_debug_enabled() -> bool {
    env_enabled("CROXY_DEBUG_API") || env_enabled("CROXY_DEBUG_API")
}

fn is_api_debug_text_enabled() -> bool {
    env_enabled("CROXY_DEBUG_API_TEXT") || env_enabled("CROXY_DEBUG_API_TEXT")
}

fn env_enabled(name: &str) -> bool {
    std::env::var(name)
        .map(|value| matches!(value.to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
        .unwrap_or(false)
}

fn summarize_output_config(value: Option<&Value>) -> Value {
    let Some(value) = value else {
        return Value::Null;
    };
    let format = value.get("format");
    json!({
        "effort": string_value(value.get("effort")),
        "format_type": format.and_then(|format| string_value(format.get("type"))),
        "schema_keys": format
            .and_then(|format| format.get("schema"))
            .and_then(Value::as_object)
            .map(|schema| {
                let mut keys = schema.keys().cloned().collect::<Vec<_>>();
                keys.sort();
                keys
            }),
    })
}

fn first_user_text(messages: Option<&Value>) -> String {
    let Some(messages) = messages.and_then(Value::as_array) else {
        return String::new();
    };
    messages
        .iter()
        .find(|message| message.get("role").and_then(Value::as_str) == Some("user"))
        .map(|message| extract_text(message.get("content")))
        .unwrap_or_default()
}

fn extract_text(value: Option<&Value>) -> String {
    let Some(value) = value else {
        return String::new();
    };
    match value {
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| extract_text(Some(item)))
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Object(object) => {
            if let Some(text) = object.get("text").and_then(Value::as_str) {
                return text.to_string();
            }
            object
                .values()
                .map(|item| extract_text(Some(item)))
                .filter(|text| !text.is_empty())
                .collect::<Vec<_>>()
                .join("\n")
        }
        _ => String::new(),
    }
}

fn system_blocks(value: Option<&Value>) -> usize {
    match value {
        Some(Value::Array(items)) => items.len(),
        Some(Value::String(_)) => 1,
        _ => 0,
    }
}

fn string_value(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str)
}

fn number_value(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64)
}

fn summarize_text(value: &str, include_preview: bool) -> Value {
    let mut digest = Sha256::new();
    digest.update(value.as_bytes());
    let hash = format!("{:x}", digest.finalize());
    let mut summary = json!({
        "chars": value.chars().count(),
        "sha256_12": if value.is_empty() { "" } else { &hash[..12] },
    });
    if include_preview {
        summary["preview"] = json!(preview(value));
    }
    summary
}

fn preview(value: &str) -> String {
    let cleaned = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let preview: String = cleaned.chars().take(MAX_PREVIEW_CHARS).collect();
    if cleaned.chars().count() > MAX_PREVIEW_CHARS {
        format!("{preview}...")
    } else {
        preview
    }
}

fn append_preview(current: &str, next: &str) -> String {
    let combined = format!("{current}{next}");
    combined.chars().take(MAX_PREVIEW_CHARS).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request_info(request_id: &str, observe: bool) -> ProxyRequestInfo {
        ProxyRequestInfo {
            request_id: request_id.to_string(),
            observe,
        }
    }

    fn sse(parsed: Value) -> SseEvent {
        SseEvent {
            event: None,
            data: parsed.to_string(),
            parsed: Some(parsed),
        }
    }

    fn line_value(line: &str) -> Value {
        serde_json::from_str(line.strip_prefix("[croxy-api] ").unwrap()).unwrap()
    }

    #[test]
    fn summarizes_request_body_without_text_by_default() {
        let mut logger = ApiDebugLogger::with_include_text(false);
        logger.on_request_body(
            &json!({
                "model": "claude-opus",
                "max_tokens": 1024,
                "system": [{"type":"text","text":"system prompt"}],
                "messages": [{"role":"user","content":"hello world"}],
                "tools": [{"name":"Read"}],
                "output_config": {"effort": "high", "format": {"type": "json_schema", "schema": {"type": "object"}}}
            }),
            "/v1/messages",
            &request_info("1", true),
        );

        let lines = logger.take_lines();
        let value = line_value(&lines[0]);
        assert_eq!(value["kind"], "api_request");
        assert_eq!(value["request_id"], "1");
        assert_eq!(value["observed"], true);
        assert_eq!(value["messages"], 1);
        assert_eq!(value["system_blocks"], 1);
        assert_eq!(value["tools"], 1);
        assert_eq!(value["system_text"]["chars"], 13);
        assert!(value["system_text"].get("preview").is_none());
        assert_eq!(value["output_config"]["schema_keys"], json!(["type"]));
    }

    #[test]
    fn includes_preview_when_text_debug_is_enabled() {
        let mut logger = ApiDebugLogger::with_include_text(true);
        logger.on_request_body(
            &json!({
                "messages": [{"role":"user","content":[{"type":"text","text":"hello"},{"type":"text","text":"world"}]}]
            }),
            "/v1/messages",
            &request_info("1", true),
        );

        let lines = logger.take_lines();
        let value = line_value(&lines[0]);
        assert_eq!(value["first_user_text"]["preview"], "hello world");
    }

    #[test]
    fn emits_response_summary_on_message_stop() {
        let mut logger = ApiDebugLogger::with_include_text(true);
        let info = request_info("1", false);
        logger.on_request_body(&json!({}), "/v1/messages", &info);
        logger.on_sse_event(&sse(json!({"type":"message_start"})), &info);
        logger.on_sse_event(
            &sse(json!({"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}})),
            &info,
        );
        logger.on_sse_event(
            &sse(
                json!({"type":"content_block_delta","delta":{"type":"text_delta","text":" there"}}),
            ),
            &info,
        );
        logger.on_sse_event(&sse(json!({"type":"message_stop"})), &info);

        let lines = logger.take_lines();
        let value = line_value(&lines[1]);
        assert_eq!(value["kind"], "api_response");
        assert_eq!(value["observed"], false);
        assert_eq!(value["saw_message_start"], true);
        assert_eq!(value["assistant_text"]["preview"], "Hi there");
    }
}
