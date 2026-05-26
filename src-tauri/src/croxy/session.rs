use crate::croxy::args::{Args, InputFormat};
use crate::croxy::backends::{BackendCapabilities, Observation};
use crate::croxy::output::{
    InitData, OutputEmitter, PostTurnSummary, ResultMeta, ResultSubtype, SessionState, configure,
};
use crate::croxy::pty::{
    PtyKiller, PtyWriter, send_interrupt, send_permission_allow, send_permission_deny, send_prompt,
    send_slash_command,
};
use crate::croxy::transcript_events::{
    format_transcript_api_error, format_transcript_api_retry, get_transcript_api_error_info,
    get_transcript_assistant_text, is_retry_exhausted, is_transcript_api_error,
    is_transcript_api_error_message,
};
use anyhow::Result;
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::io::Write;
use std::time::Instant;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaudeStatus {
    Busy,
    Idle,
    Waiting,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionExit {
    Running,
    Requested(i32),
}

#[derive(Debug)]
pub struct SessionController<W, O>
where
    W: PtyWriter + PtyKiller,
    O: Write,
{
    args: Args,
    backend_capabilities: BackendCapabilities,
    pty: W,
    output: OutputEmitter,
    writer: O,
    pending_prompts: VecDeque<String>,
    turn_active: bool,
    turn_count: u64,
    turn_start: Option<Instant>,
    claude_ready: bool,
    waiting_for_action: bool,
    process_exited: bool,
    stdin_closed: bool,
    pending_permission_request_id: Option<String>,
    permission_request_seq: u64,
    observed_post_turn_summary: bool,
    exit: SessionExit,
}

impl<W, O> SessionController<W, O>
where
    W: PtyWriter + PtyKiller,
    O: Write,
{
    pub fn new(args: Args, backend_capabilities: BackendCapabilities, pty: W, writer: O) -> Self {
        let output = OutputEmitter::new(configure(&args));
        Self {
            args,
            backend_capabilities,
            pty,
            output,
            writer,
            pending_prompts: VecDeque::new(),
            turn_active: false,
            turn_count: 0,
            turn_start: None,
            claude_ready: false,
            waiting_for_action: false,
            process_exited: false,
            stdin_closed: false,
            pending_permission_request_id: None,
            permission_request_seq: 0,
            observed_post_turn_summary: false,
            exit: SessionExit::Running,
        }
    }

    pub fn into_parts(self) -> (W, O) {
        (self.pty, self.writer)
    }

    pub fn exit_state(&self) -> SessionExit {
        self.exit
    }

    pub fn turn_count(&self) -> u64 {
        self.turn_count
    }

    pub fn is_turn_active(&self) -> bool {
        self.turn_active
    }

    pub fn pending_len(&self) -> usize {
        self.pending_prompts.len()
    }

    pub fn enqueue_prompt(&mut self, prompt: impl Into<String>) {
        self.pending_prompts.push_back(prompt.into());
    }

    pub fn next_prompt(&mut self) -> Option<String> {
        self.pending_prompts.pop_front()
    }

    pub fn handle_observation(&mut self, observation: Observation) -> Result<()> {
        if self.process_exited {
            return Ok(());
        }
        match observation {
            Observation::Sse(event) => self.output.emit_sse(&event, &mut self.writer)?,
            Observation::RateLimit {
                status_code,
                retry_after,
            } => self.output.emit_rate_limit_event(
                status_code,
                retry_after.as_deref(),
                None,
                &mut self.writer,
            )?,
            Observation::ApiRetry { status_code } => {
                self.output
                    .emit_api_retry(status_code, None, &mut self.writer)?;
            }
            Observation::Error { message } => {
                tracing::debug!(message, "backend observation error");
            }
        }
        Ok(())
    }

    pub fn handle_status(&mut self, status: ClaudeStatus, waiting_for: Option<&str>) -> Result<()> {
        if self.process_exited {
            return Ok(());
        }

        let status_text = match status {
            ClaudeStatus::Busy => "busy",
            ClaudeStatus::Idle => "idle",
            ClaudeStatus::Waiting => "waiting",
        };
        self.output
            .emit_status(status_text, waiting_for, &mut self.writer)?;

        match status {
            ClaudeStatus::Busy => {
                self.waiting_for_action = false;
                self.observed_post_turn_summary = false;
                self.output
                    .emit_session_state_changed(SessionState::Running, &mut self.writer)?;
                if !self.turn_active {
                    self.turn_active = true;
                    self.turn_count += 1;
                    self.turn_start = Some(Instant::now());
                    if let Some(max_turns) = self.args.max_turns
                        && self.turn_count > u64::from(max_turns)
                    {
                        send_interrupt(&mut self.pty);
                    }
                }
            }
            ClaudeStatus::Waiting => {
                self.waiting_for_action = true;
                self.output
                    .emit_session_state_changed(SessionState::RequiresAction, &mut self.writer)?;
                if waiting_for.is_some() && self.pending_permission_request_id.is_none() {
                    self.emit_permission_request()?;
                }
            }
            ClaudeStatus::Idle => {
                self.waiting_for_action = false;
                self.pending_permission_request_id = None;
                self.output
                    .emit_session_state_changed(SessionState::Idle, &mut self.writer)?;
                if self.turn_active {
                    self.complete_turn()?;
                }
                self.claude_ready = true;
                self.dispatch_next_prompt_if_ready()?;
                self.maybe_exit_after_input_drained();
            }
        }

        Ok(())
    }

    pub fn handle_control_request(
        &mut self,
        request: &Value,
        request_id: Option<&str>,
    ) -> Result<()> {
        if self.process_exited {
            return Ok(());
        }
        match request.get("subtype").and_then(Value::as_str) {
            Some("interrupt") | Some("stop_task") if self.should_forward_control_interrupt() => {
                send_interrupt(&mut self.pty);
            }
            Some("get_context_usage") => {
                if let Some(request_id) = request_id {
                    self.output.emit_control_response(
                        request_id,
                        json!({ "context_usage": self.output.context_usage() }),
                        &mut self.writer,
                    )?;
                }
            }
            Some("set_model") => {
                if let Some(model) = request.get("model").and_then(Value::as_str) {
                    send_slash_command(&mut self.pty, &format!("model {model}"));
                }
            }
            _ => {}
        }
        Ok(())
    }

    pub fn handle_control_response(&mut self, response: &Value, request_id: &str) {
        if self.process_exited {
            return;
        }
        if self.pending_permission_request_id.as_deref() != Some(request_id) {
            return;
        }
        let permission_response = response.get("response").unwrap_or(response);
        match permission_response.get("behavior").and_then(Value::as_str) {
            Some("allow") => send_permission_allow(&mut self.pty),
            Some("deny") => send_permission_deny(&mut self.pty),
            _ => {}
        }
        self.pending_permission_request_id = None;
    }

    pub fn handle_transcript_event(&mut self, event: Value) -> Result<()> {
        if self.process_exited {
            return Ok(());
        }
        self.note_transcript_event(&event);
        self.output
            .emit_transcript_event(event.clone(), &mut self.writer)?;

        if is_transcript_api_error(&event) {
            let Some(info) = get_transcript_api_error_info(&event) else {
                return Ok(());
            };
            if self.args.output_format == crate::croxy::args::OutputFormat::Text {
                eprintln!("{}", format_transcript_api_retry(&info));
            }
            if is_retry_exhausted(&info) {
                self.complete_turn_with_error(
                    format_transcript_api_error(&info),
                    info.status,
                    Some("api_error"),
                )?;
            }
            return Ok(());
        }

        if is_transcript_api_error_message(&event) {
            let text = get_transcript_assistant_text(&event);
            let message = if text.is_empty() {
                "Claude API error".to_string()
            } else {
                text
            };
            let status = event
                .get("apiErrorStatus")
                .and_then(Value::as_u64)
                .and_then(|status| u16::try_from(status).ok());
            self.complete_turn_with_error(message, status, Some("api_error"))?;
        }
        Ok(())
    }

    pub fn emit_transcript_event(&mut self, event: Value) -> Result<()> {
        self.note_transcript_event(&event);
        self.output.emit_transcript_event(event, &mut self.writer)
    }

    pub fn emit_init(&mut self, session_id: &str) -> Result<()> {
        self.output.emit_init(
            session_id,
            &self.args.cwd.display().to_string(),
            InitData::default(),
            &mut self.writer,
        )
    }

    pub fn confirm_hidden_prompt(&mut self) {
        send_permission_allow(&mut self.pty);
    }

    pub fn interrupt(&mut self) {
        if self.process_exited {
            return;
        }
        send_interrupt(&mut self.pty);
    }

    pub fn shutdown(&mut self, code: i32) {
        if self.process_exited {
            self.exit = SessionExit::Requested(code);
            return;
        }
        self.request_exit(code);
    }

    pub fn handle_stdin_eof(&mut self) {
        self.stdin_closed = true;
        self.maybe_exit_after_input_drained();
    }

    pub fn dispatch_next_prompt_if_ready(&mut self) -> Result<()> {
        if !self.claude_ready || self.turn_active || self.process_exited {
            return Ok(());
        }
        let Some(prompt) = self.pending_prompts.pop_front() else {
            return Ok(());
        };
        self.output.reset_accumulated_text();
        self.output.emit_user_replay(&prompt, &mut self.writer)?;
        self.claude_ready = false;
        send_prompt(&mut self.pty, &prompt);
        Ok(())
    }

    pub fn handle_claude_exit(&mut self, code: i32) -> Result<()> {
        if self.process_exited {
            return Ok(());
        }
        self.process_exited = true;
        if self.turn_active && !self.backend_capabilities.emits_results {
            let text = self.output.accumulated_text().to_string();
            let subtype = if code == 0 {
                ResultSubtype::Success
            } else {
                ResultSubtype::Error
            };
            let result = if code == 0 {
                text
            } else {
                format!("Claude exited with code {code}")
            };
            self.output.emit_result(
                subtype,
                &result,
                ResultMeta {
                    duration_ms: self.turn_duration_ms(),
                    num_turns: Some(self.turn_count),
                    ..ResultMeta::default()
                },
                &mut self.writer,
            )?;
        }
        self.exit = SessionExit::Requested(if code == 0 { 0 } else { code });
        Ok(())
    }

    fn complete_turn(&mut self) -> Result<()> {
        self.turn_active = false;
        let text = self.output.accumulated_text().to_string();
        if !self.backend_capabilities.emits_post_turn_summary && !self.observed_post_turn_summary {
            self.output.emit_post_turn_summary(
                PostTurnSummary {
                    summarizes_uuid: None,
                    status_category: "completed".to_string(),
                    status_detail: "Turn completed successfully".to_string(),
                    title: first_line_title(&text),
                    description: text.chars().take(200).collect(),
                    recent_action: self
                        .output
                        .last_tool_use()
                        .map(|tool| format!("Used {}", tool.name))
                        .unwrap_or_else(|| "Generated text response".to_string()),
                    needs_action: String::new(),
                    is_noteworthy: false,
                    artifact_urls: Vec::new(),
                },
                &mut self.writer,
            )?;
        }
        if !self.backend_capabilities.emits_results {
            self.output.emit_result(
                ResultSubtype::Success,
                &text,
                ResultMeta {
                    duration_ms: self.turn_duration_ms(),
                    num_turns: Some(self.turn_count),
                    stop_reason: self.output.last_stop_reason().map(str::to_string),
                    ..ResultMeta::default()
                },
                &mut self.writer,
            )?;
        }
        self.output.reset_accumulated_text();
        self.observed_post_turn_summary = false;
        if self.args.input_format != InputFormat::StreamJson {
            self.request_exit(0);
        }
        Ok(())
    }

    fn complete_turn_with_error(
        &mut self,
        message: String,
        status: Option<u16>,
        stop_reason: Option<&str>,
    ) -> Result<()> {
        self.turn_active = false;
        self.output.emit_post_turn_summary(
            PostTurnSummary {
                summarizes_uuid: None,
                status_category: "failed".to_string(),
                status_detail: status
                    .map(|status| format!("API error {status}"))
                    .unwrap_or_else(|| "API error".to_string()),
                title: first_line_title(&message),
                description: message.chars().take(200).collect(),
                recent_action: "Received Claude API error".to_string(),
                needs_action: String::new(),
                is_noteworthy: true,
                artifact_urls: Vec::new(),
            },
            &mut self.writer,
        )?;
        self.output.emit_result(
            ResultSubtype::Error,
            &message,
            ResultMeta {
                duration_ms: self.turn_duration_ms(),
                num_turns: Some(self.turn_count.max(1)),
                stop_reason: stop_reason.map(str::to_string),
                api_error_status: status,
                ..ResultMeta::default()
            },
            &mut self.writer,
        )?;
        self.output.reset_accumulated_text();
        self.observed_post_turn_summary = false;
        if self.args.input_format != InputFormat::StreamJson {
            self.request_exit(1);
        } else {
            self.claude_ready = true;
            self.maybe_exit_after_input_drained();
        }
        Ok(())
    }

    fn emit_permission_request(&mut self) -> Result<()> {
        let Some(tool_use) = self.output.last_tool_use().cloned() else {
            return Ok(());
        };
        self.permission_request_seq += 1;
        let request_id = format!("permission-{}", self.permission_request_seq);
        self.output.emit_control_request(
            &request_id,
            &tool_use.name,
            &tool_use.id,
            &tool_use.input,
            None,
            &mut self.writer,
        )?;
        self.pending_permission_request_id = Some(request_id);
        Ok(())
    }

    fn should_forward_control_interrupt(&self) -> bool {
        self.turn_active || self.waiting_for_action || self.pending_permission_request_id.is_some()
    }

    fn maybe_exit_after_input_drained(&mut self) {
        if self.stdin_closed
            && !self.turn_active
            && self.claude_ready
            && self.pending_prompts.is_empty()
        {
            self.request_exit(0);
        }
    }

    fn request_exit(&mut self, code: i32) {
        self.pty.kill(Some("SIGTERM"));
        self.exit = SessionExit::Requested(code);
    }

    fn turn_duration_ms(&self) -> Option<u64> {
        self.turn_start
            .map(|started| started.elapsed().as_millis() as u64)
    }

    fn note_transcript_event(&mut self, event: &Value) {
        if event.get("type").and_then(Value::as_str) == Some("system")
            && event.get("subtype").and_then(Value::as_str) == Some("post_turn_summary")
        {
            self.observed_post_turn_summary = true;
        }
    }
}

fn first_line_title(text: &str) -> String {
    let title: String = text
        .lines()
        .next()
        .unwrap_or("Turn completed")
        .chars()
        .take(80)
        .collect();
    if title.is_empty() {
        "Turn completed".to_string()
    } else {
        title
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::croxy::args::{OutputFormat, parse_args};
    use crate::croxy::backends::SseEvent;

    #[derive(Debug, Default)]
    struct MockPty {
        writes: Vec<String>,
        kills: Vec<String>,
    }

    impl PtyWriter for MockPty {
        fn write(&mut self, data: &str) {
            self.writes.push(data.to_string());
        }
    }

    impl PtyKiller for MockPty {
        fn kill(&mut self, signal: Option<&str>) {
            self.kills.push(signal.unwrap_or("").to_string());
        }
    }

    fn args(argv: &[&str]) -> Args {
        parse_args(argv.iter().map(|arg| arg.to_string()))
            .unwrap()
            .unwrap()
    }

    fn controller(argv: &[&str]) -> SessionController<MockPty, Vec<u8>> {
        SessionController::new(
            args(argv),
            BackendCapabilities::PROXY,
            MockPty::default(),
            Vec::new(),
        )
    }

    fn parsed_lines(output: &[u8]) -> Vec<Value> {
        String::from_utf8(output.to_vec())
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn sse(parsed: Value) -> Observation {
        Observation::Sse(SseEvent {
            event: None,
            data: parsed.to_string(),
            parsed: Some(parsed),
        })
    }

    #[test]
    fn queues_prompts_fifo() {
        let mut controller = controller(&["--input-format", "stream-json"]);
        controller.enqueue_prompt("first");
        controller.enqueue_prompt("second");

        assert_eq!(controller.pending_len(), 2);
        assert_eq!(controller.next_prompt().as_deref(), Some("first"));
        assert_eq!(controller.next_prompt().as_deref(), Some("second"));
        assert_eq!(controller.next_prompt(), None);
    }

    #[test]
    fn idle_dispatches_queued_prompt_when_ready() {
        let mut controller = controller(&[
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--replay-user-messages",
        ]);
        controller.enqueue_prompt("hello");

        controller.handle_status(ClaudeStatus::Idle, None).unwrap();
        let (pty, output) = controller.into_parts();

        assert_eq!(pty.writes, vec!["hello", "\r"]);
        let lines = parsed_lines(&output);
        assert!(lines.iter().any(|line| line["type"] == "user"));
    }

    #[test]
    fn enqueue_after_idle_dispatches_prompt_immediately() {
        let mut controller = controller(&[
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--replay-user-messages",
        ]);

        controller.handle_status(ClaudeStatus::Idle, None).unwrap();
        controller.enqueue_prompt("late prompt");
        controller.dispatch_next_prompt_if_ready().unwrap();
        let (pty, output) = controller.into_parts();

        assert_eq!(pty.writes, vec!["late prompt", "\r"]);
        let lines = parsed_lines(&output);
        let replay = lines.iter().find(|line| line["type"] == "user").unwrap();
        assert_eq!(replay["message"]["content"], "late prompt");
    }

    #[test]
    fn stdin_eof_after_dispatch_waits_for_turn_to_finish() {
        let mut controller = controller(&["--input-format", "stream-json"]);

        controller.handle_status(ClaudeStatus::Idle, None).unwrap();
        controller.enqueue_prompt("late prompt");
        controller.dispatch_next_prompt_if_ready().unwrap();
        controller.handle_stdin_eof();

        assert_eq!(controller.exit_state(), SessionExit::Running);
        controller.handle_status(ClaudeStatus::Busy, None).unwrap();
        controller.handle_status(ClaudeStatus::Idle, None).unwrap();
        assert_eq!(controller.exit_state(), SessionExit::Requested(0));
    }

    #[test]
    fn busy_then_idle_emits_summary_and_result() {
        let mut controller = controller(&["--output-format", "stream-json"]);

        controller.handle_status(ClaudeStatus::Busy, None).unwrap();
        controller
            .handle_observation(sse(
                json!({"type":"message_start","message":{"id":"m1","model":"test","content":[]}}),
            ))
            .unwrap();
        controller
            .handle_observation(sse(
                json!({"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}),
            ))
            .unwrap();
        controller
            .handle_observation(sse(json!({"type":"message_stop"})))
            .unwrap();
        controller.handle_status(ClaudeStatus::Idle, None).unwrap();

        let (_pty, output) = controller.into_parts();
        let lines = parsed_lines(&output);
        let summary_idx = lines
            .iter()
            .position(|line| line["subtype"] == "post_turn_summary")
            .unwrap();
        let result_idx = lines
            .iter()
            .position(|line| line["type"] == "result")
            .unwrap();
        assert!(summary_idx < result_idx);
        assert_eq!(lines[result_idx]["result"], "Hello");
        assert_eq!(lines[result_idx]["num_turns"], 1);
    }

    #[test]
    fn transcript_post_turn_summary_suppresses_fallback_summary() {
        let mut controller = controller(&["--output-format", "stream-json"]);

        controller.handle_status(ClaudeStatus::Busy, None).unwrap();
        controller
            .emit_transcript_event(json!({
                "type": "system",
                "subtype": "post_turn_summary",
                "status_category": "completed",
                "status_detail": "Transcript summary",
                "title": "From transcript",
                "description": "Claude wrote this summary",
                "recent_action": "Used Read",
                "needs_action": "",
                "is_noteworthy": false,
                "artifact_urls": [],
                "session_id": "sess-1"
            }))
            .unwrap();
        controller.handle_status(ClaudeStatus::Idle, None).unwrap();

        let (_pty, output) = controller.into_parts();
        let lines = parsed_lines(&output);
        let summaries = lines
            .iter()
            .filter(|line| line["subtype"] == "post_turn_summary")
            .collect::<Vec<_>>();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0]["title"], "From transcript");
        assert!(lines.iter().any(|line| line["type"] == "result"));
    }

    #[test]
    fn max_turns_interrupts_when_exceeded() {
        let mut controller = controller(&["--input-format", "stream-json", "--max-turns", "1"]);

        controller.handle_status(ClaudeStatus::Busy, None).unwrap();
        controller.handle_status(ClaudeStatus::Idle, None).unwrap();
        controller.handle_status(ClaudeStatus::Busy, None).unwrap();
        let (pty, _output) = controller.into_parts();

        assert!(pty.writes.contains(&"\x1b".to_string()));
    }

    #[test]
    fn waiting_with_last_tool_use_emits_permission_request_and_accepts_response() {
        let mut controller = controller(&["--output-format", "stream-json"]);
        for event in [
            json!({"type":"message_start","message":{"id":"m1","model":"test","content":[]}}),
            json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_01","name":"Bash"}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"command\":\"ls\"}"}}),
            json!({"type":"content_block_stop","index":0}),
        ] {
            controller.handle_observation(sse(event)).unwrap();
        }

        controller
            .handle_status(ClaudeStatus::Waiting, Some("approve Bash"))
            .unwrap();
        let request_id = {
            let lines = parsed_lines(&controller.writer);
            let request = lines
                .iter()
                .find(|line| line["type"] == "control_request")
                .unwrap();
            assert_eq!(request["request"]["tool_name"], "Bash");
            request["request_id"].as_str().unwrap().to_string()
        };
        controller.handle_control_response(&json!({"behavior": "allow"}), &request_id);
        let (pty, _output) = controller.into_parts();

        assert!(pty.writes.contains(&"\r".to_string()));
    }

    #[test]
    fn permission_control_response_accepts_nested_response_shape() {
        let mut controller = controller(&["--output-format", "stream-json"]);
        for event in [
            json!({"type":"message_start","message":{"id":"m1","model":"test","content":[]}}),
            json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_01","name":"Bash"}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"command\":\"ls\"}"}}),
            json!({"type":"content_block_stop","index":0}),
        ] {
            controller.handle_observation(sse(event)).unwrap();
        }
        controller
            .handle_status(ClaudeStatus::Waiting, Some("approve Bash"))
            .unwrap();
        let request_id = {
            let lines = parsed_lines(&controller.writer);
            lines
                .iter()
                .find(|line| line["type"] == "control_request")
                .unwrap()["request_id"]
                .as_str()
                .unwrap()
                .to_string()
        };

        controller.handle_control_response(
            &json!({"response": {"behavior": "deny", "message": "no"}}),
            &request_id,
        );
        let (pty, _output) = controller.into_parts();

        assert!(pty.writes.contains(&"\x1b".to_string()));
    }

    #[test]
    fn control_requests_interrupt_only_when_active_and_set_model_uses_slash_command() {
        let mut controller = controller(&["--input-format", "stream-json"]);

        controller
            .handle_control_request(&json!({"subtype": "interrupt"}), None)
            .unwrap();
        controller
            .handle_control_request(&json!({"subtype": "set_model", "model": "sonnet"}), None)
            .unwrap();
        controller.handle_status(ClaudeStatus::Busy, None).unwrap();
        controller
            .handle_control_request(&json!({"subtype": "interrupt"}), None)
            .unwrap();
        let (pty, _output) = controller.into_parts();

        assert!(pty.writes.contains(&"/model sonnet\r".to_string()));
        assert_eq!(
            pty.writes.iter().filter(|write| *write == "\x1b").count(),
            1
        );
    }

    #[test]
    fn get_context_usage_emits_control_response() {
        let mut controller = controller(&["--output-format", "stream-json"]);

        controller
            .handle_control_request(&json!({"subtype": "get_context_usage"}), Some("req-1"))
            .unwrap();
        let (_pty, output) = controller.into_parts();
        let lines = parsed_lines(&output);
        let response = lines
            .iter()
            .find(|line| line["type"] == "control_response")
            .unwrap();

        assert_eq!(response["request_id"], "req-1");
        assert!(response["response"]["context_usage"].is_object());
    }

    #[test]
    fn single_prompt_text_mode_requests_exit_after_turn() {
        let mut args = args(&["hello"]);
        args.output_format = OutputFormat::Text;
        let mut controller = SessionController::new(
            args,
            BackendCapabilities::PROXY,
            MockPty::default(),
            Vec::new(),
        );

        controller.handle_status(ClaudeStatus::Busy, None).unwrap();
        controller.handle_status(ClaudeStatus::Idle, None).unwrap();
        assert_eq!(controller.exit_state(), SessionExit::Requested(0));
        let (pty, _output) = controller.into_parts();
        assert_eq!(pty.kills, vec!["SIGTERM"]);
    }

    #[test]
    fn interrupt_sends_escape_and_shutdown_kills_child_with_code() {
        let mut controller = controller(&["--input-format", "stream-json"]);

        controller.interrupt();
        controller.shutdown(143);

        assert_eq!(controller.exit_state(), SessionExit::Requested(143));
        let (pty, _output) = controller.into_parts();
        assert_eq!(pty.writes, vec!["\x1b"]);
        assert_eq!(pty.kills, vec!["SIGTERM"]);
    }
}
