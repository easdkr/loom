#![allow(dead_code)]

pub mod api_debug;
pub mod args;
pub mod backends;
pub mod claude_prompts;
pub mod engine;
pub mod message_assembler;
pub mod output;
pub mod pid_watcher;
pub mod pty;
pub mod session;
pub mod stdin_reader;
pub mod transcript_events;
pub mod transcript_observer;

use crate::croxy::api_debug::{ApiDebugLogger, is_api_debug_enabled};
use crate::croxy::args::{Args, InputFormat, OutputFormat};
use crate::croxy::backends::{
    BackendCapabilities, Observation, ProxyCallbacks, ProxyOptions, RequestBodyCallback,
    SseEventCallback, start_proxy,
};
use crate::croxy::claude_prompts::{
    WorkspaceTrustPromptDetector, should_auto_confirm_workspace_trust, strip_terminal_controls,
};
use crate::croxy::pid_watcher::{PidWatcher, StatusChange};
use crate::croxy::pty::{PtyCommand, PtyHandle, spawn_claude};
use crate::croxy::session::{ClaudeStatus, SessionController, SessionExit};
use crate::croxy::stdin_reader::{
    MAX_STREAM_JSON_LINE_BYTES, StdinEvent, StdinReadConfig, parse_stdin_line,
};
use crate::croxy::transcript_events::{is_transcript_api_error, is_transcript_api_error_message};
use crate::croxy::transcript_observer::TranscriptObserver;
use anyhow::Result;
use std::io::{BufRead, IsTerminal, Read};
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

pub fn run(argv: impl IntoIterator<Item = String>) -> Result<i32> {
    run_with_runtime(argv, RuntimeHooks::real())
}

pub(crate) type SpawnFn =
    dyn Fn(PtyCommand, RuntimeSender) -> Result<Box<dyn PtyHandle>> + Send + Sync;

#[derive(Clone)]
pub(crate) struct RuntimeSender(pub(crate) mpsc::Sender<RuntimeEvent>);

impl RuntimeSender {
    pub(crate) fn send(&self, event: RuntimeEvent) {
        let _ = self.0.send(event);
    }
}

struct RuntimeHooks {
    spawn: Arc<SpawnFn>,
    stdin_is_tty: bool,
}

impl RuntimeHooks {
    fn real() -> Self {
        Self {
            spawn: Arc::new(|command, sender| {
                let data_sender = sender.clone();
                let exit_sender = sender;
                let handle = spawn_claude(
                    command,
                    Box::new(move |data| data_sender.send(RuntimeEvent::PtyData(data))),
                    Box::new(move |code, _signal| {
                        exit_sender.send(RuntimeEvent::ClaudeExit(code as i32));
                    }),
                )?;
                Ok(Box::new(handle))
            }),
            stdin_is_tty: std::io::stdin().is_terminal(),
        }
    }
}

#[derive(Debug)]
pub(crate) enum RuntimeEvent {
    Observation(Observation),
    Stdin(StdinEvent),
    PtyData(String),
    ClaudeExit(i32),
    Interrupt,
    Shutdown(i32),
    AssumeReady,
}

fn run_with_runtime(argv: impl IntoIterator<Item = String>, hooks: RuntimeHooks) -> Result<i32> {
    let Some(args) = args::parse_args(argv)? else {
        return Ok(0);
    };

    if args.should_print_help_for_empty_tty(hooks.stdin_is_tty) {
        args::print_help();
        return Ok(0);
    }

    tracing::debug!(?args, "parsed croxy args");
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    runtime.block_on(run_async(args, hooks.spawn))
}

async fn run_async(args: Args, spawn: Arc<SpawnFn>) -> Result<i32> {
    if let Some(max_budget_usd) = args.max_budget_usd {
        eprintln!(
            "croxy warning: --max-budget-usd={max_budget_usd} is accepted for compatibility but is not enforced yet."
        );
    }

    let (tx, rx) = mpsc::channel();
    let sender = RuntimeSender(tx.clone());
    install_signal_handlers(tx.clone());
    let api_debug_logger =
        is_api_debug_enabled().then(|| Arc::new(Mutex::new(ApiDebugLogger::new())));
    let on_request_body: Option<RequestBodyCallback> = api_debug_logger.as_ref().map(|logger| {
        let logger = Arc::clone(logger);
        Arc::new(
            move |body: serde_json::Value,
                  path: String,
                  info: crate::croxy::backends::ProxyRequestInfo| {
                if let Ok(mut logger) = logger.lock() {
                    logger.on_request_body(&body, &path, &info);
                }
            },
        ) as RequestBodyCallback
    });
    let on_sse_event: Option<SseEventCallback> = api_debug_logger.as_ref().map(|logger| {
        let logger = Arc::clone(logger);
        Arc::new(move |event, _path, info| {
            if let Ok(mut logger) = logger.lock() {
                logger.on_sse_event(&event, &info);
            }
        }) as SseEventCallback
    });

    let proxy = start_proxy(
        ProxyCallbacks {
            on_sse_event,
            on_observation: Some(Arc::new(move |observation| {
                let _ = tx.send(RuntimeEvent::Observation(observation));
            })),
            on_proxy_error: Some(Arc::new(|message| {
                tracing::debug!(message, "proxy error");
            })),
            on_request_body,
            ..ProxyCallbacks::default()
        },
        ProxyOptions::default(),
    )
    .await?;

    let command = build_claude_command(&args, proxy.port());
    let pty = match spawn(command, sender.clone()) {
        Ok(pty) => pty,
        Err(err) => {
            proxy.stop().await;
            return Err(err);
        }
    };

    if args.prompt.is_none() {
        start_startup_ready_timer(sender.clone());
    }
    start_stdin_reader(args.clone(), sender);

    let code = run_event_loop(args, pty, rx);
    proxy.stop().await;
    Ok(code)
}

pub(crate) fn build_claude_command(args: &Args, proxy_port: u16) -> PtyCommand {
    let mut backend_env = std::collections::HashMap::new();
    backend_env.insert(
        "ANTHROPIC_BASE_URL".to_string(),
        format!("http://127.0.0.1:{proxy_port}"),
    );

    let mut claude_args = args.claude_args.clone();
    if let Some(prompt) = &args.prompt {
        claude_args.push(prompt.clone());
    }
    PtyCommand::claude(claude_args, backend_env, &args.cwd)
}

fn start_stdin_reader(args: Args, sender: RuntimeSender) {
    let config = StdinReadConfig::from(&args);
    thread::spawn(move || match config.input_format {
        InputFormat::StreamJson => read_stream_json_stdin(sender),
        InputFormat::Text if !config.has_prompt || config.read_prompt_from_stdin => {
            read_text_stdin(sender)
        }
        InputFormat::Text => {}
    });
}

fn read_text_stdin(sender: RuntimeSender) {
    let mut input = String::new();
    if let Err(err) = std::io::stdin().read_to_string(&mut input) {
        sender.send(RuntimeEvent::Stdin(StdinEvent::MalformedLine(format!(
            "stdin read error: {err}"
        ))));
        return;
    }
    let prompt = input.trim();
    if !prompt.is_empty() {
        sender.send(RuntimeEvent::Stdin(StdinEvent::UserMessage(
            prompt.to_string(),
        )));
    }
    sender.send(RuntimeEvent::Stdin(StdinEvent::Eof));
}

fn read_stream_json_stdin(sender: RuntimeSender) {
    let stdin = std::io::stdin();
    let mut reader = stdin.lock();
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => {
                sender.send(RuntimeEvent::Stdin(StdinEvent::Eof));
                break;
            }
            Ok(_) => {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if trimmed.len() > MAX_STREAM_JSON_LINE_BYTES {
                    sender.send(RuntimeEvent::Stdin(StdinEvent::MalformedLine(format!(
                        "stream-json input line exceeded {MAX_STREAM_JSON_LINE_BYTES} bytes; ignored"
                    ))));
                    continue;
                }
                if let Some(event) = parse_stdin_line(trimmed) {
                    sender.send(RuntimeEvent::Stdin(event));
                }
            }
            Err(err) => {
                sender.send(RuntimeEvent::Stdin(StdinEvent::MalformedLine(format!(
                    "stdin read error: {err}"
                ))));
                sender.send(RuntimeEvent::Stdin(StdinEvent::Eof));
                break;
            }
        }
    }
}

fn run_event_loop(args: Args, pty: Box<dyn PtyHandle>, rx: mpsc::Receiver<RuntimeEvent>) -> i32 {
    run_event_loop_with_writer(args, pty, rx, std::io::stdout())
}

pub(crate) fn run_event_loop_with_writer<W, O>(
    args: Args,
    pty: W,
    rx: mpsc::Receiver<RuntimeEvent>,
    writer: O,
) -> i32
where
    W: PtyHandle,
    O: std::io::Write,
{
    let pty_pid = pty.pid();
    let mut controller =
        SessionController::new(args.clone(), BackendCapabilities::PROXY, pty, writer);
    let mut trust_detector = WorkspaceTrustPromptDetector::new();
    let auto_trust = should_auto_confirm_workspace_trust(&args.claude_args);
    let mut pid_watcher = pty_pid.map(PidWatcher::new);
    let mut observed_transcript_path = None;
    let mut transcript_observer = None;
    let mut emitted_transcript_init = false;
    let mut recent_pty_text = String::new();

    if args.output_format == OutputFormat::StreamJson {
        let session_id = fallback_session_id(pty_pid);
        let _ = controller.emit_init(&session_id);
    }

    let mut exit_code = 0;
    loop {
        poll_pid_and_transcript(
            &mut controller,
            &mut pid_watcher,
            &mut observed_transcript_path,
            &mut transcript_observer,
            &mut emitted_transcript_init,
        );

        let event = match rx.recv_timeout(Duration::from_millis(250)) {
            Ok(event) => event,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if let SessionExit::Requested(code) = controller.exit_state() {
                    exit_code = code;
                    break;
                }
                continue;
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        };

        match event {
            RuntimeEvent::Observation(observation) => {
                handle_observation_event(&mut controller, observation);
            }
            RuntimeEvent::Stdin(event) => {
                handle_stdin_event(&mut controller, event);
            }
            RuntimeEvent::PtyData(data) => {
                let text = strip_terminal_controls(&data);
                if !text.trim().is_empty() {
                    tracing::debug!(pty = %text.trim(), "claude PTY");
                    append_recent_pty_text(&mut recent_pty_text, &text);
                }
                if trust_detector.push(&data) {
                    if auto_trust {
                        controller.confirm_hidden_prompt();
                    } else {
                        eprintln!(
                            "croxy error: Claude Code is asking to trust this workspace ({}), but croxy runs Claude in a hidden PTY.\nRun `claude` in this directory and choose \"Yes, I trust this folder\", then retry croxy. Alternatively, retry with --dangerously-skip-permissions if that is appropriate for this workspace.",
                            args.cwd.display()
                        );
                        exit_code = 1;
                        break;
                    }
                }
            }
            RuntimeEvent::ClaudeExit(code) => {
                if code != 0 {
                    let message = recent_pty_text.trim();
                    if !message.is_empty() {
                        let _ = controller.emit_process_error_result(
                            &format!("croxy backend exited with code {code}:\n{message}"),
                            code,
                        );
                    }
                }
                let _ = controller.handle_claude_exit(code);
                exit_code = if controller.is_turn_active() && code != 0 {
                    code
                } else {
                    match controller.exit_state() {
                        SessionExit::Requested(code) => code,
                        SessionExit::Running => 0,
                    }
                };
                break;
            }
            RuntimeEvent::Interrupt => {
                controller.interrupt();
            }
            RuntimeEvent::Shutdown(code) => {
                controller.shutdown(code);
            }
            RuntimeEvent::AssumeReady => {
                if !controller.is_turn_active() {
                    let _ = controller.handle_status(ClaudeStatus::Idle, None);
                }
            }
        }

        if let SessionExit::Requested(code) = controller.exit_state() {
            exit_code = code;
            break;
        }
    }

    exit_code
}

const RECENT_PTY_TEXT_LIMIT: usize = 16 * 1024;

fn append_recent_pty_text(buffer: &mut String, text: &str) {
    buffer.push_str(text);
    if buffer.len() <= RECENT_PTY_TEXT_LIMIT {
        return;
    }
    let keep_from = buffer
        .char_indices()
        .rev()
        .map(|(index, _)| index)
        .find(|index| buffer.len() - *index >= RECENT_PTY_TEXT_LIMIT)
        .unwrap_or(0);
    buffer.drain(..keep_from);
}

pub(crate) fn start_startup_ready_timer(sender: RuntimeSender) {
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(1500));
        sender.send(RuntimeEvent::AssumeReady);
    });
}

fn install_signal_handlers(tx: mpsc::Sender<RuntimeEvent>) {
    let interrupt_tx = tx.clone();
    tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            let _ = interrupt_tx.send(RuntimeEvent::Interrupt);
        }
    });

    #[cfg(unix)]
    {
        tokio::spawn(async move {
            let Ok(mut signal) =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            else {
                return;
            };
            signal.recv().await;
            let _ = tx.send(RuntimeEvent::Shutdown(143));
        });
    }
}

fn fallback_session_id(pty_pid: Option<u32>) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    match pty_pid {
        Some(pid) => format!("croxy-{pid}-{now}"),
        None => format!("croxy-{now}"),
    }
}

fn poll_pid_and_transcript(
    controller: &mut SessionController<impl PtyHandle, impl std::io::Write>,
    pid_watcher: &mut Option<PidWatcher>,
    observed_transcript_path: &mut Option<std::path::PathBuf>,
    transcript_observer: &mut Option<TranscriptObserver>,
    emitted_transcript_init: &mut bool,
) {
    let Some(watcher) = pid_watcher.as_mut() else {
        return;
    };

    if let Some(change) = watcher.poll() {
        emit_latest_transcript_summary_before_idle(controller, watcher, &change);
        handle_pid_status(controller, change);
        emit_transcript_init_if_available(controller, watcher, emitted_transcript_init);
    }

    if let Some(path) = watcher.get_transcript_path()
        && observed_transcript_path.as_ref() != Some(&path)
    {
        *observed_transcript_path = Some(path.clone());
        *transcript_observer = Some(TranscriptObserver::new(path));
    }

    let Some(observer) = transcript_observer.as_mut() else {
        return;
    };
    for event in observer.poll() {
        if is_transcript_api_error(&event) || is_transcript_api_error_message(&event) {
            let _ = controller.handle_transcript_event(event);
        }
    }
}

fn emit_transcript_init_if_available(
    controller: &mut SessionController<impl PtyHandle, impl std::io::Write>,
    watcher: &PidWatcher,
    emitted_transcript_init: &mut bool,
) {
    if *emitted_transcript_init {
        return;
    }
    if let Some(init) = watcher.read_transcript_init() {
        let _ = controller.emit_transcript_event(init);
        *emitted_transcript_init = true;
    }
}

fn emit_latest_transcript_summary_before_idle(
    controller: &mut SessionController<impl PtyHandle, impl std::io::Write>,
    watcher: &PidWatcher,
    change: &StatusChange,
) {
    if change.status != "idle" {
        return;
    }
    if let Some(summary) = watcher
        .read_transcript_events("post_turn_summary", 4096)
        .into_iter()
        .last()
    {
        let _ = controller.emit_transcript_event(summary);
    }
}

fn handle_pid_status(
    controller: &mut SessionController<impl PtyHandle, impl std::io::Write>,
    change: StatusChange,
) {
    let status = match change.status.as_str() {
        "busy" => ClaudeStatus::Busy,
        "waiting" => ClaudeStatus::Waiting,
        "idle" => ClaudeStatus::Idle,
        _ => return,
    };
    let _ = controller.handle_status(status, change.waiting_for.as_deref());
}

fn handle_observation_event(
    controller: &mut SessionController<impl PtyHandle, impl std::io::Write>,
    observation: Observation,
) {
    let sse_type = match &observation {
        Observation::Sse(event) => event
            .parsed
            .as_ref()
            .and_then(|value| value.get("type"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        _ => None,
    };

    if sse_type.as_deref() == Some("message_start") {
        let _ = controller.handle_status(ClaudeStatus::Busy, None);
    }
    let _ = controller.handle_observation(observation);
    if sse_type.as_deref() == Some("message_stop") {
        let _ = controller.handle_status(ClaudeStatus::Idle, None);
    }
}

fn handle_stdin_event(
    controller: &mut SessionController<impl PtyHandle, impl std::io::Write>,
    event: StdinEvent,
) {
    match event {
        StdinEvent::UserMessage(content) => {
            controller.enqueue_prompt(content);
            let _ = controller.dispatch_next_prompt_if_ready();
        }
        StdinEvent::ControlRequest {
            request,
            request_id,
        } => {
            let _ = controller.handle_control_request(&request, request_id.as_deref());
        }
        StdinEvent::ControlResponse {
            response,
            request_id,
        } => controller.handle_control_response(&response, &request_id),
        StdinEvent::KeepAlive => {}
        StdinEvent::Eof => controller.handle_stdin_eof(),
        StdinEvent::MalformedLine(message) => eprintln!("croxy input error: {message}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::croxy::args::parse_args;
    use crate::croxy::pty::{PtyKiller, PtyWriter};

    #[derive(Debug, Default)]
    struct MockPty;

    impl PtyWriter for MockPty {
        fn write(&mut self, _data: &str) {}
    }

    impl PtyKiller for MockPty {
        fn kill(&mut self, _signal: Option<&str>) {}
    }

    impl PtyHandle for MockPty {
        fn resize(&mut self, _cols: u16, _rows: u16) -> Result<()> {
            Ok(())
        }

        fn pid(&self) -> Option<u32> {
            Some(123)
        }
    }

    fn parse(argv: &[&str]) -> Args {
        parse_args(argv.iter().map(|arg| arg.to_string()))
            .unwrap()
            .unwrap()
    }

    #[test]
    fn build_claude_command_appends_prompt_and_proxy_env() {
        let args = parse(&["--model", "sonnet", "hello"]);

        let command = build_claude_command(&args, 3456);

        assert_eq!(command.args, vec!["--model", "sonnet", "hello"]);
        assert_eq!(
            command.env.get("ANTHROPIC_BASE_URL").map(String::as_str),
            Some("http://127.0.0.1:3456")
        );
        assert_eq!(command.cwd, args.cwd);
    }

    #[test]
    fn build_claude_command_keeps_croxy_formats_out_of_claude_args() {
        let args = parse(&[
            "-p",
            "--input-format",
            "stream-json",
            "--output-format=stream-json",
            "--include-partial-messages",
            "--replay-user-messages",
            "--permission-mode",
            "bypassPermissions",
        ]);

        let command = build_claude_command(&args, 3456);

        assert_eq!(command.args, vec!["--permission-mode", "bypassPermissions"]);
    }

    #[test]
    fn nonzero_startup_exit_emits_recent_pty_output_as_error_result() {
        let args = parse(&[
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
        ]);
        let (tx, rx) = mpsc::channel();
        tx.send(RuntimeEvent::PtyData(
            "Authentication failed before startup\n".to_string(),
        ))
        .unwrap();
        tx.send(RuntimeEvent::ClaudeExit(1)).unwrap();
        drop(tx);

        let mut output = Vec::new();
        let code = run_event_loop_with_writer(args, MockPty, rx, &mut output);

        assert_eq!(code, 1);
        let text = String::from_utf8(output).unwrap();
        assert!(text.contains("\"type\":\"result\""));
        assert!(text.contains("\"is_error\":true"));
        assert!(text.contains("Authentication failed before startup"));
    }

    #[test]
    fn help_exits_before_runtime_spawn() {
        let hooks = RuntimeHooks {
            spawn: Arc::new(|_, _| Ok(Box::new(MockPty) as Box<dyn PtyHandle>)),
            stdin_is_tty: false,
        };

        let code = run_with_runtime(["--help".to_string()], hooks).unwrap();

        assert_eq!(code, 0);
    }
}
