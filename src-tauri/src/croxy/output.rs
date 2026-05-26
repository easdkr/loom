use crate::croxy::args::{Args, OutputFormat};
use crate::croxy::backends::SseEvent;
use crate::croxy::message_assembler::{ContextUsage, MessageAssembler, ToolUse};
use anyhow::Result;
use serde::Serialize;
use serde_json::{Value, json};
use std::io::Write;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OutputConfig {
    pub format: OutputFormat,
    pub verbose: bool,
    pub include_partial: bool,
    pub replay_user_messages: bool,
}

pub fn configure(args: &Args) -> OutputConfig {
    OutputConfig {
        format: args.output_format,
        verbose: args.verbose,
        include_partial: args.include_partial,
        replay_user_messages: args.replay_user_messages,
    }
}

#[derive(Debug)]
pub struct OutputEmitter {
    config: OutputConfig,
    assembler: MessageAssembler,
    accumulated_text: String,
    last_response_text: String,
    current_message_text: String,
    current_stop_reason: Option<String>,
    last_stop_reason: Option<String>,
    session_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionState {
    Idle,
    Running,
    RequiresAction,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResultSubtype {
    Success,
    Error,
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct ResultMeta {
    pub cost_usd: Option<f64>,
    pub duration_ms: Option<u64>,
    pub num_turns: Option<u64>,
    pub stop_reason: Option<String>,
    pub api_error_status: Option<u16>,
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct InitData {
    pub model: Option<String>,
    pub tools: Vec<String>,
    pub mcp_servers: Vec<Value>,
    pub permission_mode: Option<String>,
    pub slash_commands: Vec<String>,
    pub claude_code_version: Option<String>,
    pub output_style: Option<String>,
    pub agents: Vec<String>,
    pub skills: Vec<String>,
    pub plugins: Vec<String>,
    pub fast_mode_state: Option<String>,
    pub memory_paths: Option<Value>,
    pub api_key_source: Option<String>,
}

const MAX_ACCUMULATED_TEXT_CHARS: usize = 1_000_000;

impl OutputEmitter {
    pub fn new(config: OutputConfig) -> Self {
        Self {
            config,
            assembler: MessageAssembler::new(),
            accumulated_text: String::new(),
            last_response_text: String::new(),
            current_message_text: String::new(),
            current_stop_reason: None,
            last_stop_reason: None,
            session_id: String::new(),
        }
    }

    pub fn accumulated_text(&self) -> &str {
        if self.last_response_text.is_empty() {
            &self.accumulated_text
        } else {
            &self.last_response_text
        }
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn last_tool_use(&self) -> Option<&ToolUse> {
        self.assembler.last_tool_use()
    }

    pub fn context_usage(&self) -> &ContextUsage {
        self.assembler.context_usage()
    }

    pub fn last_stop_reason(&self) -> Option<&str> {
        self.last_stop_reason.as_deref()
    }

    pub fn reset_accumulated_text(&mut self) {
        self.accumulated_text.clear();
        self.last_response_text.clear();
        self.last_stop_reason = None;
    }

    pub fn reset(&mut self) {
        self.reset_accumulated_text();
        self.current_message_text.clear();
        self.current_stop_reason = None;
        self.session_id.clear();
        self.assembler.reset();
    }

    pub fn emit_sse(&mut self, event: &SseEvent, writer: &mut impl Write) -> Result<()> {
        if let Some(parsed) = event.parsed.as_ref().and_then(Value::as_object) {
            for message in self.assembler.process_sse(event) {
                if self.config.format == OutputFormat::StreamJson && self.config.verbose {
                    self.write_json_line(
                        json!({
                            "type": "assistant",
                            "message": message,
                            "session_id": self.session_id,
                        }),
                        writer,
                    )?;
                }
            }

            match parsed.get("type").and_then(Value::as_str) {
                Some("message_start") => {
                    self.current_message_text.clear();
                    self.current_stop_reason = None;
                }
                Some("content_block_delta") => {
                    let delta = parsed.get("delta").and_then(Value::as_object);
                    if delta
                        .and_then(|delta| delta.get("type"))
                        .and_then(Value::as_str)
                        == Some("text_delta")
                    {
                        let text = delta
                            .and_then(|delta| delta.get("text"))
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        append_capped(&mut self.accumulated_text, text);
                        append_capped(&mut self.current_message_text, text);
                    }
                }
                Some("message_stop") => {
                    if !self.current_message_text.is_empty() {
                        self.last_response_text = self.current_message_text.clone();
                    }
                    self.last_stop_reason = self.current_stop_reason.take();
                    self.current_message_text.clear();
                }
                Some("message_delta") => {
                    self.current_stop_reason = parsed
                        .get("delta")
                        .and_then(Value::as_object)
                        .and_then(|delta| delta.get("stop_reason"))
                        .and_then(Value::as_str)
                        .map(str::to_string);
                }
                _ => {}
            }
        }

        if self.config.format != OutputFormat::StreamJson {
            return Ok(());
        }

        let Some(parsed) = event.parsed.as_ref() else {
            return Ok(());
        };
        let Some(event_type) = parsed.get("type").and_then(Value::as_str) else {
            return Ok(());
        };
        if event_type == "assistant" || event_type == "user" {
            return Ok(());
        }

        if is_stream_event(event_type) {
            if self.config.include_partial {
                self.write_json_line(
                    json!({
                        "type": "stream_event",
                        "event": parsed,
                        "session_id": self.session_id,
                    }),
                    writer,
                )?;
            }
        } else if self.config.verbose {
            self.write_json_line(parsed, writer)?;
        }

        Ok(())
    }

    pub fn emit_user_replay(&self, content: &str, writer: &mut impl Write) -> Result<()> {
        if !self.config.replay_user_messages || self.config.format != OutputFormat::StreamJson {
            return Ok(());
        }
        self.write_json_line(
            json!({
                "type": "user",
                "message": {
                    "role": "user",
                    "content": content,
                },
                "session_id": self.session_id,
            }),
            writer,
        )
    }

    pub fn emit_status(
        &self,
        status: &str,
        waiting_for: Option<&str>,
        writer: &mut impl Write,
    ) -> Result<()> {
        if self.config.format != OutputFormat::StreamJson {
            return Ok(());
        }
        let mut message = json!({
            "type": "system",
            "subtype": "status",
            "status": status,
            "session_id": self.session_id,
        });
        if let Some(waiting_for) = waiting_for {
            message["waiting_for"] = json!(waiting_for);
        }
        self.write_json_line(message, writer)
    }

    pub fn emit_session_state_changed(
        &self,
        state: SessionState,
        writer: &mut impl Write,
    ) -> Result<()> {
        if self.config.format != OutputFormat::StreamJson {
            return Ok(());
        }
        self.write_json_line(
            json!({
                "type": "system",
                "subtype": "session_state_changed",
                "state": state.as_str(),
                "session_id": self.session_id,
            }),
            writer,
        )
    }

    pub fn emit_init(
        &mut self,
        session_id: &str,
        cwd: &str,
        data: InitData,
        writer: &mut impl Write,
    ) -> Result<()> {
        self.session_id = session_id.to_string();
        if self.config.format != OutputFormat::StreamJson {
            return Ok(());
        }
        let mut message = json!({
            "type": "system",
            "subtype": "init",
            "session_id": session_id,
            "cwd": cwd,
            "tools": data.tools,
            "mcp_servers": data.mcp_servers,
            "model": data.model.unwrap_or_else(|| "unknown".to_string()),
            "permissionMode": data.permission_mode.unwrap_or_else(|| "default".to_string()),
            "slash_commands": data.slash_commands,
            "apiKeySource": data.api_key_source.unwrap_or_else(|| "none".to_string()),
            "claude_code_version": data.claude_code_version.unwrap_or_else(|| "unknown".to_string()),
            "output_style": data.output_style.unwrap_or_else(|| "default".to_string()),
            "agents": data.agents,
            "skills": data.skills,
            "plugins": data.plugins,
            "fast_mode_state": data.fast_mode_state.unwrap_or_else(|| "off".to_string()),
        });
        if let Some(memory_paths) = data.memory_paths {
            message["memory_paths"] = memory_paths;
        }
        self.write_json_line(message, writer)
    }

    pub fn emit_api_retry(
        &self,
        status_code: u16,
        retry_after_ms: Option<u64>,
        writer: &mut impl Write,
    ) -> Result<()> {
        if self.config.format != OutputFormat::StreamJson || !self.config.verbose {
            return Ok(());
        }
        let mut message = json!({
            "type": "system",
            "subtype": "api_retry",
            "status_code": status_code,
            "session_id": self.session_id,
        });
        if let Some(retry_after_ms) = retry_after_ms {
            message["retry_after_ms"] = json!(retry_after_ms);
        }
        self.write_json_line(message, writer)
    }

    pub fn emit_rate_limit_event(
        &self,
        status_code: u16,
        retry_after: Option<&str>,
        limit_type: Option<&str>,
        writer: &mut impl Write,
    ) -> Result<()> {
        if self.config.format != OutputFormat::StreamJson {
            return Ok(());
        }
        let mut message = json!({
            "type": "rate_limit_event",
            "status_code": status_code,
            "session_id": self.session_id,
        });
        if let Some(retry_after) = retry_after {
            message["retry_after"] = json!(retry_after);
        }
        if let Some(limit_type) = limit_type {
            message["limit_type"] = json!(limit_type);
        }
        self.write_json_line(message, writer)
    }

    pub fn emit_control_request(
        &self,
        request_id: &str,
        tool_name: &str,
        tool_use_id: &str,
        input: &Value,
        description: Option<&str>,
        writer: &mut impl Write,
    ) -> Result<()> {
        if self.config.format != OutputFormat::StreamJson {
            return Ok(());
        }
        let mut request = json!({
            "subtype": "can_use_tool",
            "tool_name": tool_name,
            "input": input,
            "tool_use_id": tool_use_id,
        });
        if let Some(description) = description {
            request["description"] = json!(description);
        }
        self.write_json_line(
            json!({
                "type": "control_request",
                "request_id": request_id,
                "request": request,
                "session_id": self.session_id,
            }),
            writer,
        )
    }

    pub fn emit_control_response(
        &self,
        request_id: &str,
        response: Value,
        writer: &mut impl Write,
    ) -> Result<()> {
        if self.config.format != OutputFormat::StreamJson {
            return Ok(());
        }
        self.write_json_line(
            json!({
                "type": "control_response",
                "request_id": request_id,
                "response": response,
                "session_id": self.session_id,
            }),
            writer,
        )
    }

    pub fn emit_post_turn_summary(
        &self,
        opts: PostTurnSummary,
        writer: &mut impl Write,
    ) -> Result<()> {
        if self.config.format != OutputFormat::StreamJson {
            return Ok(());
        }
        self.write_json_line(
            json!({
                "type": "system",
                "subtype": "post_turn_summary",
                "summarizes_uuid": opts.summarizes_uuid.unwrap_or_default(),
                "status_category": opts.status_category,
                "status_detail": opts.status_detail,
                "is_noteworthy": opts.is_noteworthy,
                "title": opts.title,
                "description": opts.description,
                "recent_action": opts.recent_action,
                "needs_action": opts.needs_action,
                "artifact_urls": opts.artifact_urls,
                "session_id": self.session_id,
            }),
            writer,
        )
    }

    pub fn emit_transcript_event(&mut self, event: Value, writer: &mut impl Write) -> Result<()> {
        if let Some(session_id) = event.get("session_id").and_then(Value::as_str) {
            self.session_id = session_id.to_string();
        }
        if self.config.format != OutputFormat::StreamJson {
            return Ok(());
        }
        self.write_json_line(event, writer)
    }

    pub fn emit_result(
        &self,
        subtype: ResultSubtype,
        result: &str,
        meta: ResultMeta,
        writer: &mut impl Write,
    ) -> Result<()> {
        if self.config.format == OutputFormat::Text {
            writer.write_all(result.as_bytes())?;
            if !result.ends_with('\n') {
                writer.write_all(b"\n")?;
            }
            return Ok(());
        }

        let mut message = json!({
            "type": "result",
            "subtype": subtype.as_str(),
            "result": result,
            "is_error": subtype != ResultSubtype::Success,
            "session_id": self.session_id,
        });
        insert_optional(&mut message, "cost_usd", meta.cost_usd);
        insert_optional(&mut message, "duration_ms", meta.duration_ms);
        insert_optional(&mut message, "num_turns", meta.num_turns);
        insert_optional(&mut message, "api_error_status", meta.api_error_status);
        if let Some(stop_reason) = meta.stop_reason {
            message["stop_reason"] = json!(stop_reason);
        }
        self.write_json_line(message, writer)
    }

    fn write_json_line(&self, value: impl Serialize, writer: &mut impl Write) -> Result<()> {
        serde_json::to_writer(&mut *writer, &value)?;
        writer.write_all(b"\n")?;
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct PostTurnSummary {
    pub summarizes_uuid: Option<String>,
    pub status_category: String,
    pub status_detail: String,
    pub title: String,
    pub description: String,
    pub recent_action: String,
    pub needs_action: String,
    pub is_noteworthy: bool,
    pub artifact_urls: Vec<String>,
}

impl SessionState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Running => "running",
            Self::RequiresAction => "requires_action",
        }
    }
}

impl ResultSubtype {
    fn as_str(self) -> &'static str {
        match self {
            Self::Success => "success",
            Self::Error => "error",
        }
    }
}

fn is_stream_event(event_type: &str) -> bool {
    matches!(
        event_type,
        "message_start"
            | "content_block_start"
            | "content_block_delta"
            | "content_block_stop"
            | "message_delta"
            | "message_stop"
    )
}

fn append_capped(current: &mut String, next: &str) {
    current.push_str(next);
    if current.len() > MAX_ACCUMULATED_TEXT_CHARS {
        let remove_until = current.len() - MAX_ACCUMULATED_TEXT_CHARS;
        current.drain(..remove_until);
    }
}

fn insert_optional<T: Serialize>(message: &mut Value, key: &str, value: Option<T>) {
    if let Some(value) = value {
        message[key] = json!(value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn emitter(format: OutputFormat, verbose: bool, include_partial: bool) -> OutputEmitter {
        OutputEmitter::new(OutputConfig {
            format,
            verbose,
            include_partial,
            replay_user_messages: false,
        })
    }

    fn sse(parsed: Value) -> SseEvent {
        SseEvent {
            event: None,
            data: parsed.to_string(),
            parsed: Some(parsed),
        }
    }

    fn lines(output: &[u8]) -> Vec<Value> {
        String::from_utf8(output.to_vec())
            .expect("test output should be utf8")
            .lines()
            .map(|line| serde_json::from_str(line).expect("line should be json"))
            .collect()
    }

    #[test]
    fn accumulates_text_delta_content() {
        let mut emitter = emitter(OutputFormat::StreamJson, true, true);
        let mut output = Vec::new();

        emitter.emit_sse(&sse(json!({"type":"message_start","message":{"id":"m1","model":"test","content":[]}})), &mut output).unwrap();
        emitter.emit_sse(&sse(json!({"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}})), &mut output).unwrap();
        emitter.emit_sse(&sse(json!({"type":"content_block_delta","delta":{"type":"text_delta","text":" world"}})), &mut output).unwrap();
        emitter
            .emit_sse(
                &sse(json!({"type":"message_delta","delta":{"stop_reason":"end_turn"}})),
                &mut output,
            )
            .unwrap();
        emitter
            .emit_sse(&sse(json!({"type":"message_stop"})), &mut output)
            .unwrap();

        assert_eq!(emitter.accumulated_text(), "Hello world");
        assert_eq!(emitter.last_stop_reason(), Some("end_turn"));
    }

    #[test]
    fn wraps_partial_stream_events_when_enabled() {
        let mut emitter = emitter(OutputFormat::StreamJson, true, true);
        let mut output = Vec::new();

        emitter
            .emit_sse(
                &sse(
                    json!({"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}),
                ),
                &mut output,
            )
            .unwrap();

        let lines = lines(&output);
        assert_eq!(lines[0]["type"], "stream_event");
        assert_eq!(lines[0]["event"]["type"], "content_block_delta");
    }

    #[test]
    fn suppresses_partial_stream_events_when_disabled() {
        let mut emitter = emitter(OutputFormat::StreamJson, true, false);
        let mut output = Vec::new();

        emitter
            .emit_sse(
                &sse(
                    json!({"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}),
                ),
                &mut output,
            )
            .unwrap();

        assert!(output.is_empty());
    }

    #[test]
    fn emits_assembled_assistant_before_content_block_stop_partial() {
        let mut emitter = emitter(OutputFormat::StreamJson, true, true);
        let mut output = Vec::new();

        for event in [
            sse(
                json!({"type":"message_start","message":{"id":"m1","model":"test-model","content":[],"usage":{"input_tokens":10}}}),
            ),
            sse(
                json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
            ),
            sse(
                json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}),
            ),
            sse(json!({"type":"content_block_stop","index":0})),
            sse(
                json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}),
            ),
            sse(json!({"type":"message_stop"})),
        ] {
            emitter.emit_sse(&event, &mut output).unwrap();
        }

        let lines = lines(&output);
        let assistant_idx = lines
            .iter()
            .position(|line| line["type"] == "assistant")
            .expect("assistant line should be emitted");
        let block_stop_idx = lines
            .iter()
            .position(|line| {
                line["type"] == "stream_event" && line["event"]["type"] == "content_block_stop"
            })
            .expect("content_block_stop stream event should be emitted");
        assert!(assistant_idx < block_stop_idx);
        assert_eq!(
            lines[assistant_idx]["message"]["content"][0]["text"],
            "Hello"
        );
        assert_eq!(lines[assistant_idx]["message"]["model"], "test-model");
    }

    #[test]
    fn emits_user_replay_only_when_enabled_in_stream_json() {
        let mut emitter = OutputEmitter::new(OutputConfig {
            format: OutputFormat::StreamJson,
            verbose: true,
            include_partial: true,
            replay_user_messages: true,
        });
        let mut output = Vec::new();

        emitter
            .emit_user_replay("hello world", &mut output)
            .unwrap();

        let lines = lines(&output);
        assert_eq!(lines[0]["type"], "user");
        assert_eq!(lines[0]["message"]["content"], "hello world");

        emitter.config.replay_user_messages = false;
        output.clear();
        emitter
            .emit_user_replay("hello world", &mut output)
            .unwrap();
        assert!(output.is_empty());
    }

    #[test]
    fn emits_init_status_state_and_rate_limit_events() {
        let mut emitter = emitter(OutputFormat::StreamJson, true, false);
        let mut output = Vec::new();

        emitter
            .emit_init(
                "sess-1",
                "/tmp",
                InitData {
                    model: Some("opus".to_string()),
                    tools: vec!["Bash".to_string(), "Read".to_string()],
                    permission_mode: Some("bypassPermissions".to_string()),
                    claude_code_version: Some("2.1.0".to_string()),
                    ..InitData::default()
                },
                &mut output,
            )
            .unwrap();
        emitter
            .emit_status("waiting", Some("approve Bash"), &mut output)
            .unwrap();
        emitter
            .emit_session_state_changed(SessionState::RequiresAction, &mut output)
            .unwrap();
        emitter
            .emit_rate_limit_event(429, Some("5"), None, &mut output)
            .unwrap();

        let lines = lines(&output);
        assert_eq!(lines[0]["subtype"], "init");
        assert_eq!(lines[0]["session_id"], "sess-1");
        assert_eq!(lines[0]["permissionMode"], "bypassPermissions");
        assert_eq!(lines[1]["waiting_for"], "approve Bash");
        assert_eq!(lines[2]["state"], "requires_action");
        assert_eq!(lines[3]["type"], "rate_limit_event");
    }

    #[test]
    fn emits_result_as_text_or_json() {
        let text_emitter = emitter(OutputFormat::Text, false, false);
        let mut output = Vec::new();
        text_emitter
            .emit_result(
                ResultSubtype::Success,
                "Hello",
                ResultMeta::default(),
                &mut output,
            )
            .unwrap();
        assert_eq!(String::from_utf8(output).unwrap(), "Hello\n");

        let json_emitter = emitter(OutputFormat::Json, false, false);
        let mut output = Vec::new();
        json_emitter
            .emit_result(
                ResultSubtype::Error,
                "fail",
                ResultMeta {
                    duration_ms: Some(1000),
                    stop_reason: Some("api_error".to_string()),
                    ..ResultMeta::default()
                },
                &mut output,
            )
            .unwrap();
        let lines = lines(&output);
        assert_eq!(lines[0]["type"], "result");
        assert_eq!(lines[0]["is_error"], true);
        assert_eq!(lines[0]["duration_ms"], 1000);
        assert_eq!(lines[0]["stop_reason"], "api_error");
    }
}
