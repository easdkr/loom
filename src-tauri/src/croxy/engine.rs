use crate::croxy::args::{Args, InputFormat, OutputFormat};
use crate::croxy::backends::{ProxyCallbacks, ProxyOptions, start_proxy};
use crate::croxy::pty::{PtyCommand, PtyHandle, spawn_claude};
use crate::croxy::stdin_reader::StdinEvent;
use crate::croxy::{
    RuntimeEvent, RuntimeSender, SpawnFn, build_claude_command, run_event_loop_with_writer,
    start_startup_ready_timer,
};
use anyhow::{Context, Result};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct EngineSessionId(u64);

impl EngineSessionId {
    pub fn get(self) -> u64 {
        self.0
    }
}

#[derive(Debug, Clone)]
pub struct EngineConfig {
    pub cwd: PathBuf,
    pub claude_args: Vec<String>,
    pub max_turns: Option<u32>,
    pub replay_user_messages: bool,
    pub include_partial: bool,
}

impl Default for EngineConfig {
    fn default() -> Self {
        Self {
            cwd: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
            claude_args: Vec::new(),
            max_turns: None,
            replay_user_messages: true,
            include_partial: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum EngineCommand {
    Prompt(String),
    Interrupt,
    PermissionResponse {
        request_id: String,
        behavior: PermissionBehavior,
    },
    SetModel(String),
    Shutdown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionBehavior {
    Allow,
    Deny,
}

#[derive(Debug, Clone, PartialEq)]
pub enum EngineEvent {
    Started {
        session_id: EngineSessionId,
        claude_session_id: String,
        cwd: String,
        model: String,
    },
    StatusChanged {
        session_id: EngineSessionId,
        status: String,
        waiting_for: Option<String>,
    },
    AssistantTextDelta {
        session_id: EngineSessionId,
        text: String,
    },
    ToolUse {
        session_id: EngineSessionId,
        tool_use_id: String,
        name: String,
        input: Option<Value>,
    },
    PermissionRequest {
        session_id: EngineSessionId,
        request_id: String,
        tool_name: String,
        tool_use_id: String,
        input: Value,
    },
    Result {
        session_id: EngineSessionId,
        is_error: bool,
        result: String,
    },
    Error {
        session_id: EngineSessionId,
        message: String,
    },
    Exited {
        session_id: EngineSessionId,
        code: i32,
    },
}

#[derive(Debug)]
pub struct EngineSessionHandle {
    id: EngineSessionId,
    commands: mpsc::Sender<EngineCommand>,
    broadcaster: EventBroadcaster,
}

impl EngineSessionHandle {
    pub fn id(&self) -> EngineSessionId {
        self.id
    }

    pub fn send(&self, command: EngineCommand) -> Result<()> {
        self.commands
            .send(command)
            .context("engine session command channel is closed")
    }

    pub fn events(&self) -> mpsc::Receiver<EngineEvent> {
        self.broadcaster.subscribe()
    }
}

#[derive(Debug, Default)]
pub struct EngineManager {
    next_id: AtomicU64,
    sessions: Mutex<HashMap<EngineSessionId, EngineSessionHandle>>,
}

impl EngineManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn spawn(&self, config: EngineConfig) -> Result<EngineSessionHandle> {
        self.spawn_with(config, real_spawn())
    }

    pub(crate) fn spawn_with(
        &self,
        config: EngineConfig,
        spawn: Arc<SpawnFn>,
    ) -> Result<EngineSessionHandle> {
        let id = EngineSessionId(self.next_id.fetch_add(1, Ordering::Relaxed) + 1);
        let (command_tx, command_rx) = mpsc::channel();
        let broadcaster = EventBroadcaster::default();
        let session = EngineSessionHandle {
            id,
            commands: command_tx,
            broadcaster: broadcaster.clone(),
        };
        let stored = session.clone();
        self.sessions.lock().unwrap().insert(id, stored);
        thread::spawn(move || {
            if let Err(err) = run_engine_thread(id, config, command_rx, broadcaster.clone(), spawn)
            {
                broadcaster.emit(EngineEvent::Error {
                    session_id: id,
                    message: err.to_string(),
                });
                broadcaster.emit(EngineEvent::Exited {
                    session_id: id,
                    code: 1,
                });
            }
        });
        Ok(session)
    }

    pub fn get(&self, id: EngineSessionId) -> Option<EngineSessionHandle> {
        self.sessions.lock().unwrap().get(&id).cloned()
    }

    pub fn shutdown(&self, id: EngineSessionId) -> Result<()> {
        if let Some(session) = self.get(id) {
            session.send(EngineCommand::Shutdown)?;
        }
        self.sessions.lock().unwrap().remove(&id);
        Ok(())
    }

    pub fn session_ids(&self) -> Vec<EngineSessionId> {
        self.sessions.lock().unwrap().keys().copied().collect()
    }
}

impl Clone for EngineSessionHandle {
    fn clone(&self) -> Self {
        Self {
            id: self.id,
            commands: self.commands.clone(),
            broadcaster: self.broadcaster.clone(),
        }
    }
}

fn run_engine_thread(
    id: EngineSessionId,
    config: EngineConfig,
    command_rx: mpsc::Receiver<EngineCommand>,
    broadcaster: EventBroadcaster,
    spawn: Arc<SpawnFn>,
) -> Result<()> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    runtime.block_on(run_engine_async(id, config, command_rx, broadcaster, spawn))
}

async fn run_engine_async(
    id: EngineSessionId,
    config: EngineConfig,
    command_rx: mpsc::Receiver<EngineCommand>,
    broadcaster: EventBroadcaster,
    spawn: Arc<SpawnFn>,
) -> Result<()> {
    let (runtime_tx, runtime_rx) = mpsc::channel();
    let sender = RuntimeSender(runtime_tx.clone());
    let observation_sender = sender.clone();
    thread::spawn(move || forward_engine_commands(command_rx, runtime_tx));

    let proxy = start_proxy(
        ProxyCallbacks {
            on_observation: Some(Arc::new(move |observation| {
                let _ = observation_sender
                    .0
                    .send(RuntimeEvent::Observation(observation));
            })),
            on_proxy_error: Some(Arc::new({
                let broadcaster = broadcaster.clone();
                move |message| {
                    broadcaster.emit(EngineEvent::Error {
                        session_id: id,
                        message,
                    });
                }
            })),
            ..ProxyCallbacks::default()
        },
        ProxyOptions::default(),
    )
    .await?;

    let args = args_from_config(config);
    let pty = match spawn(
        build_claude_command(&args, proxy.port()),
        RuntimeSender(sender.0.clone()),
    ) {
        Ok(pty) => pty,
        Err(err) => {
            proxy.stop().await;
            return Err(err);
        }
    };

    start_startup_ready_timer(RuntimeSender(sender.0));
    let writer = EventSinkWriter::new(id, broadcaster.clone());
    let code = run_event_loop_with_writer(args, pty, runtime_rx, writer);
    proxy.stop().await;
    broadcaster.emit(EngineEvent::Exited {
        session_id: id,
        code,
    });
    Ok(())
}

fn forward_engine_commands(
    command_rx: mpsc::Receiver<EngineCommand>,
    runtime_tx: mpsc::Sender<RuntimeEvent>,
) {
    for command in command_rx {
        let event = match command {
            EngineCommand::Prompt(prompt) => RuntimeEvent::Stdin(StdinEvent::UserMessage(prompt)),
            EngineCommand::Interrupt => RuntimeEvent::Interrupt,
            EngineCommand::PermissionResponse {
                request_id,
                behavior,
            } => RuntimeEvent::Stdin(StdinEvent::ControlResponse {
                request_id,
                response: json!({
                    "behavior": match behavior {
                        PermissionBehavior::Allow => "allow",
                        PermissionBehavior::Deny => "deny",
                    }
                }),
            }),
            EngineCommand::SetModel(model) => RuntimeEvent::Stdin(StdinEvent::ControlRequest {
                request: json!({ "subtype": "set_model", "model": model }),
                request_id: None,
            }),
            EngineCommand::Shutdown => RuntimeEvent::Shutdown(0),
        };
        if runtime_tx.send(event).is_err() {
            break;
        }
    }
}

fn args_from_config(config: EngineConfig) -> Args {
    Args {
        output_format: OutputFormat::StreamJson,
        input_format: InputFormat::StreamJson,
        verbose: true,
        include_partial: config.include_partial,
        replay_user_messages: config.replay_user_messages,
        max_turns: config.max_turns,
        max_budget_usd: None,
        prompt: None,
        read_prompt_from_stdin: false,
        claude_args: config.claude_args,
        cwd: config.cwd,
    }
}

fn real_spawn() -> Arc<SpawnFn> {
    Arc::new(|command: PtyCommand, sender: RuntimeSender| {
        let data_sender = sender.clone();
        let exit_sender = sender;
        let handle = spawn_claude(
            command,
            Box::new(move |data| data_sender.send(RuntimeEvent::PtyData(data))),
            Box::new(move |code, _signal| {
                exit_sender.send(RuntimeEvent::ClaudeExit(code as i32));
            }),
        )?;
        Ok(Box::new(handle) as Box<dyn PtyHandle>)
    })
}

#[derive(Debug, Clone, Default)]
struct EventBroadcaster {
    state: Arc<Mutex<EventBroadcasterState>>,
}

#[derive(Debug, Default)]
struct EventBroadcasterState {
    subscribers: Vec<mpsc::Sender<EngineEvent>>,
    history: Vec<EngineEvent>,
}

impl EventBroadcaster {
    fn subscribe(&self) -> mpsc::Receiver<EngineEvent> {
        let (tx, rx) = mpsc::channel();
        let mut state = self.state.lock().unwrap();
        for event in &state.history {
            if tx.send(event.clone()).is_err() {
                return rx;
            }
        }
        state.subscribers.push(tx);
        rx
    }

    fn emit(&self, event: EngineEvent) {
        let mut state = self.state.lock().unwrap();
        state.history.push(event.clone());
        if state.history.len() > 1_000 {
            state.history.remove(0);
        }
        state
            .subscribers
            .retain(|subscriber| subscriber.send(event.clone()).is_ok());
    }
}

struct EventSinkWriter {
    session_id: EngineSessionId,
    broadcaster: EventBroadcaster,
    line: Vec<u8>,
}

impl EventSinkWriter {
    fn new(session_id: EngineSessionId, broadcaster: EventBroadcaster) -> Self {
        Self {
            session_id,
            broadcaster,
            line: Vec::new(),
        }
    }

    fn flush_line(&mut self) {
        if self.line.is_empty() {
            return;
        }
        let Ok(line) = std::str::from_utf8(&self.line) else {
            self.line.clear();
            return;
        };
        if let Ok(value) = serde_json::from_str::<Value>(line) {
            for event in events_from_stream_json(self.session_id, &value) {
                self.broadcaster.emit(event);
            }
        }
        self.line.clear();
    }
}

impl Write for EventSinkWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        for byte in buf {
            if *byte == b'\n' {
                self.flush_line();
            } else {
                self.line.push(*byte);
            }
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.flush_line();
        Ok(())
    }
}

fn events_from_stream_json(session_id: EngineSessionId, value: &Value) -> Vec<EngineEvent> {
    let mut events = Vec::new();
    match value.get("type").and_then(Value::as_str) {
        Some("system") => match value.get("subtype").and_then(Value::as_str) {
            Some("init") => events.push(EngineEvent::Started {
                session_id,
                claude_session_id: value
                    .get("session_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                cwd: value
                    .get("cwd")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                model: value
                    .get("model")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            }),
            Some("status") => events.push(EngineEvent::StatusChanged {
                session_id,
                status: value
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                waiting_for: value
                    .get("waiting_for")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            }),
            Some("api_error") | Some("api_retry") => events.push(EngineEvent::StatusChanged {
                session_id,
                status: "retrying".to_string(),
                waiting_for: Some(api_retry_activity(value)),
            }),
            Some("session_state_changed") => events.push(EngineEvent::StatusChanged {
                session_id,
                status: value
                    .get("state")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                waiting_for: None,
            }),
            _ => {}
        },
        Some("stream_event") => {
            if let Some(event) = value.get("event") {
                append_stream_event(session_id, event, &mut events);
            }
        }
        Some("control_request") => {
            if let Some(request) = value.get("request")
                && request.get("subtype").and_then(Value::as_str) == Some("can_use_tool")
            {
                events.push(EngineEvent::PermissionRequest {
                    session_id,
                    request_id: value
                        .get("request_id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    tool_name: request
                        .get("tool_name")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    tool_use_id: request
                        .get("tool_use_id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    input: request.get("input").cloned().unwrap_or(Value::Null),
                });
            }
        }
        Some("result") => events.push(EngineEvent::Result {
            session_id,
            is_error: value
                .get("is_error")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            result: value
                .get("result")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        }),
        Some("rate_limit_event") => events.push(EngineEvent::Error {
            session_id,
            message: format!(
                "rate limited with status {}",
                value
                    .get("status_code")
                    .and_then(Value::as_u64)
                    .map(|status| status.to_string())
                    .unwrap_or_else(|| "unknown".to_string())
            ),
        }),
        _ => {}
    }
    events
}

fn api_retry_activity(value: &Value) -> String {
    let attempt = value
        .get("retryAttempt")
        .or_else(|| value.get("retry_attempt"))
        .and_then(Value::as_u64);
    let max = value
        .get("maxRetries")
        .or_else(|| value.get("max_retries"))
        .and_then(Value::as_u64);
    let cause = value
        .pointer("/cause/code")
        .or_else(|| value.pointer("/error/cause/code"))
        .and_then(Value::as_str)
        .or_else(|| {
            value
                .get("status_code")
                .and_then(Value::as_u64)
                .map(|_| "HTTP")
        });
    let suffix = match (attempt, max) {
        (Some(attempt), Some(max)) => format!(" {attempt}/{max}"),
        (Some(attempt), None) => format!(" {attempt}"),
        _ => String::new(),
    };
    match cause {
        Some(cause) => format!("API retry{suffix}: {cause}"),
        None => format!("API retry{suffix}"),
    }
}

fn append_stream_event(session_id: EngineSessionId, event: &Value, events: &mut Vec<EngineEvent>) {
    match event.get("type").and_then(Value::as_str) {
        Some("content_block_delta")
            if event.pointer("/delta/type").and_then(Value::as_str) == Some("text_delta") =>
        {
            if let Some(text) = event.pointer("/delta/text").and_then(Value::as_str)
                && !text.is_empty()
            {
                events.push(EngineEvent::AssistantTextDelta {
                    session_id,
                    text: text.to_string(),
                });
            }
        }
        Some("content_block_start")
            if event.pointer("/content_block/type").and_then(Value::as_str) == Some("tool_use") =>
        {
            events.push(EngineEvent::ToolUse {
                session_id,
                tool_use_id: event
                    .pointer("/content_block/id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                name: event
                    .pointer("/content_block/name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                input: event.pointer("/content_block/input").cloned(),
            });
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::croxy::pty::{PtyKiller, PtyWriter};

    #[test]
    fn stream_json_events_convert_to_typed_events() {
        let id = EngineSessionId(7);

        let started = events_from_stream_json(
            id,
            &json!({
                "type": "system",
                "subtype": "init",
                "session_id": "claude-1",
                "cwd": "/tmp",
                "model": "sonnet"
            }),
        );
        assert_eq!(
            started,
            vec![EngineEvent::Started {
                session_id: id,
                claude_session_id: "claude-1".to_string(),
                cwd: "/tmp".to_string(),
                model: "sonnet".to_string(),
            }]
        );

        let delta = events_from_stream_json(
            id,
            &json!({
                "type": "stream_event",
                "event": {
                    "type": "content_block_delta",
                    "delta": { "type": "text_delta", "text": "hello" }
                }
            }),
        );
        assert_eq!(
            delta,
            vec![EngineEvent::AssistantTextDelta {
                session_id: id,
                text: "hello".to_string(),
            }]
        );
    }

    #[test]
    fn control_events_convert_to_permission_request_and_result() {
        let id = EngineSessionId(9);

        let request = events_from_stream_json(
            id,
            &json!({
                "type": "control_request",
                "request_id": "permission-1",
                "request": {
                    "subtype": "can_use_tool",
                    "tool_name": "Bash",
                    "tool_use_id": "toolu_1",
                    "input": { "command": "ls" }
                }
            }),
        );
        assert_eq!(
            request,
            vec![EngineEvent::PermissionRequest {
                session_id: id,
                request_id: "permission-1".to_string(),
                tool_name: "Bash".to_string(),
                tool_use_id: "toolu_1".to_string(),
                input: json!({ "command": "ls" }),
            }]
        );

        let result = events_from_stream_json(
            id,
            &json!({"type":"result","is_error":false,"result":"done"}),
        );
        assert_eq!(
            result,
            vec![EngineEvent::Result {
                session_id: id,
                is_error: false,
                result: "done".to_string(),
            }]
        );
    }

    #[test]
    fn api_retry_system_events_keep_engine_waiting() {
        let id = EngineSessionId(11);

        let retry = events_from_stream_json(
            id,
            &json!({
                "type": "system",
                "subtype": "api_error",
                "cause": { "code": "ConnectionRefused" },
                "retryAttempt": 2,
                "maxRetries": 10
            }),
        );

        assert_eq!(
            retry,
            vec![EngineEvent::StatusChanged {
                session_id: id,
                status: "retrying".to_string(),
                waiting_for: Some("API retry 2/10: ConnectionRefused".to_string()),
            }]
        );
    }

    #[test]
    fn engine_commands_forward_to_runtime_events() {
        let (command_tx, command_rx) = mpsc::channel();
        let (runtime_tx, runtime_rx) = mpsc::channel();
        thread::spawn(move || forward_engine_commands(command_rx, runtime_tx));

        command_tx
            .send(EngineCommand::Prompt("hello".to_string()))
            .unwrap();
        command_tx.send(EngineCommand::Interrupt).unwrap();
        command_tx
            .send(EngineCommand::PermissionResponse {
                request_id: "permission-1".to_string(),
                behavior: PermissionBehavior::Deny,
            })
            .unwrap();
        command_tx
            .send(EngineCommand::SetModel("sonnet".to_string()))
            .unwrap();
        command_tx.send(EngineCommand::Shutdown).unwrap();

        assert!(matches!(
            runtime_rx.recv().unwrap(),
            RuntimeEvent::Stdin(StdinEvent::UserMessage(prompt)) if prompt == "hello"
        ));
        assert!(matches!(
            runtime_rx.recv().unwrap(),
            RuntimeEvent::Interrupt
        ));
        assert!(matches!(
            runtime_rx.recv().unwrap(),
            RuntimeEvent::Stdin(StdinEvent::ControlResponse { request_id, response })
                if request_id == "permission-1" && response["behavior"] == "deny"
        ));
        assert!(matches!(
            runtime_rx.recv().unwrap(),
            RuntimeEvent::Stdin(StdinEvent::ControlRequest { request, request_id: None })
                if request["subtype"] == "set_model" && request["model"] == "sonnet"
        ));
        assert!(matches!(
            runtime_rx.recv().unwrap(),
            RuntimeEvent::Shutdown(0)
        ));
    }

    #[test]
    fn event_subscriptions_are_isolated_by_session() {
        let first = EventBroadcaster::default();
        let second = EventBroadcaster::default();
        let first_rx = first.subscribe();
        let second_rx = second.subscribe();

        first.emit(EngineEvent::AssistantTextDelta {
            session_id: EngineSessionId(1),
            text: "first".to_string(),
        });
        second.emit(EngineEvent::AssistantTextDelta {
            session_id: EngineSessionId(2),
            text: "second".to_string(),
        });

        assert_eq!(
            first_rx.recv().unwrap(),
            EngineEvent::AssistantTextDelta {
                session_id: EngineSessionId(1),
                text: "first".to_string(),
            }
        );
        assert_eq!(
            second_rx.recv().unwrap(),
            EngineEvent::AssistantTextDelta {
                session_id: EngineSessionId(2),
                text: "second".to_string(),
            }
        );
        assert!(first_rx.try_recv().is_err());
        assert!(second_rx.try_recv().is_err());
    }

    #[test]
    fn late_subscribers_receive_session_history() {
        let broadcaster = EventBroadcaster::default();
        broadcaster.emit(EngineEvent::StatusChanged {
            session_id: EngineSessionId(3),
            status: "idle".to_string(),
            waiting_for: None,
        });

        let rx = broadcaster.subscribe();

        assert_eq!(
            rx.recv().unwrap(),
            EngineEvent::StatusChanged {
                session_id: EngineSessionId(3),
                status: "idle".to_string(),
                waiting_for: None,
            }
        );
    }

    #[derive(Debug, Default)]
    struct MockPty {
        writes: Arc<Mutex<Vec<String>>>,
        kills: Arc<Mutex<Vec<String>>>,
    }

    impl PtyWriter for MockPty {
        fn write(&mut self, data: &str) {
            self.writes.lock().unwrap().push(data.to_string());
        }
    }

    impl PtyKiller for MockPty {
        fn kill(&mut self, signal: Option<&str>) {
            self.kills
                .lock()
                .unwrap()
                .push(signal.unwrap_or_default().to_string());
        }
    }

    impl PtyHandle for MockPty {
        fn resize(&mut self, _cols: u16, _rows: u16) -> Result<()> {
            Ok(())
        }

        fn pid(&self) -> Option<u32> {
            None
        }
    }

    #[test]
    fn manager_creates_distinct_session_ids() {
        let manager = EngineManager::new();
        let config = EngineConfig::default();
        let spawn: Arc<SpawnFn> = Arc::new(|_command, sender| {
            sender.send(RuntimeEvent::ClaudeExit(0));
            Ok(Box::new(MockPty::default()) as Box<dyn PtyHandle>)
        });

        let first = manager
            .spawn_with(config.clone(), Arc::clone(&spawn))
            .unwrap();
        let second = manager.spawn_with(config, spawn).unwrap();

        assert_ne!(first.id(), second.id());
        assert!(manager.get(first.id()).is_some());
        assert!(manager.get(second.id()).is_some());
    }
}
