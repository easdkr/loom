use super::{
    ansi::strip_ansi,
    completion::{
        BoundedBuffer, CompletionDetector, DetectionKind, ErrorClass, DEFAULT_TAIL_WINDOW_BYTES,
    },
    providers::{validate_provider_for_execution, ProviderConfig, ProviderInputMode},
    text::normalize_display_text,
    utf8::Utf8StreamDecoder,
};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::PathBuf,
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Deserialize)]
pub struct PtyTask {
    pub node_id: Option<String>,
    pub provider: String,
    pub prompt: String,
    pub workdir: Option<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    pub timeout_ms: Option<u64>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PtyDataPayload {
    pub node_id: String,
    pub chunk: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PtyCompletePayload {
    pub node_id: String,
    pub result: String,
    pub completion_reason: String,
    pub exit_code: Option<u32>,
    pub timed_out: bool,
    pub truncated: bool,
    pub error_class: Option<ErrorClass>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PtyErrorPayload {
    pub node_id: String,
    pub error: String,
}

#[derive(Debug, Clone)]
pub struct PtyRunOutcome {
    pub node_id: String,
    pub result: String,
    pub completion_reason: String,
    pub exit_code: Option<u32>,
    pub timed_out: bool,
    pub truncated: bool,
    pub error_class: Option<ErrorClass>,
}

impl PtyRunOutcome {
    pub fn success(&self) -> bool {
        self.error_class.is_none()
            && !self.timed_out
            && self.exit_code.unwrap_or(0) == 0
    }
}

struct ActiveSession {
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    killer: Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>,
}

#[derive(Clone, Default)]
pub struct PtyManager {
    active: Arc<Mutex<HashMap<String, ActiveSession>>>,
}

enum ReaderEvent {
    Data(String),
    Eof,
    Error(String),
}

impl PtyManager {
    pub fn run_background(
        &self,
        app: AppHandle,
        provider: ProviderConfig,
        task: PtyTask,
    ) -> Result<String, String> {
        let node_id = task.node_id.clone().unwrap_or_else(generate_node_id);
        let task = PtyTask {
            node_id: Some(node_id.clone()),
            ..task
        };
        let manager = self.clone();

        thread::Builder::new()
            .name(format!("loom-pty-{node_id}"))
            .spawn(move || {
                let _ = manager.run_blocking(&app, provider, task);
            })
            .map_err(|error| format!("failed to spawn PTY worker: {error}"))?;

        Ok(node_id)
    }

    pub fn run_blocking(
        &self,
        app: &AppHandle,
        provider: ProviderConfig,
        task: PtyTask,
    ) -> Result<PtyRunOutcome, String> {
        let node_id = task.node_id.clone().unwrap_or_else(generate_node_id);
        match self.run_blocking_inner(app, provider, task, node_id.clone()) {
            Ok(outcome) => {
                let _ = app.emit(
                    "pty:complete",
                    PtyCompletePayload {
                        node_id: outcome.node_id.clone(),
                        result: outcome.result.clone(),
                        completion_reason: outcome.completion_reason.clone(),
                        exit_code: outcome.exit_code,
                        timed_out: outcome.timed_out,
                        truncated: outcome.truncated,
                        error_class: outcome.error_class,
                    },
                );
                Ok(outcome)
            }
            Err(error) => {
                let _ = app.emit(
                    "pty:error",
                    PtyErrorPayload {
                        node_id,
                        error: error.clone(),
                    },
                );
                Err(error)
            }
        }
    }

    pub fn write(&self, node_id: &str, input: &str) -> Result<(), String> {
        let active = self
            .active
            .lock()
            .map_err(|_| "failed to lock PTY sessions".to_string())?;
        let session = active
            .get(node_id)
            .ok_or_else(|| format!("node is not running: {node_id}"))?;
        let mut writer = session
            .writer
            .lock()
            .map_err(|_| format!("failed to lock writer for node: {node_id}"))?;

        writer
            .write_all(input.as_bytes())
            .and_then(|_| writer.flush())
            .map_err(|error| format!("failed to write to node {node_id}: {error}"))
    }

    pub fn kill(&self, node_id: &str) -> Result<(), String> {
        let active = self
            .active
            .lock()
            .map_err(|_| "failed to lock PTY sessions".to_string())?;
        let session = active
            .get(node_id)
            .ok_or_else(|| format!("node is not running: {node_id}"))?;
        let mut killer = session
            .killer
            .lock()
            .map_err(|_| format!("failed to lock killer for node: {node_id}"))?;

        killer
            .kill()
            .map_err(|error| format!("failed to kill node {node_id}: {error}"))
    }

    pub fn resize(&self, node_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let size = normalize_pty_size(cols, rows);
        let active = self
            .active
            .lock()
            .map_err(|_| "failed to lock PTY sessions".to_string())?;
        let session = active
            .get(node_id)
            .ok_or_else(|| format!("node is not running: {node_id}"))?;
        let master = session
            .master
            .lock()
            .map_err(|_| format!("failed to lock PTY master for node: {node_id}"))?;

        master
            .resize(size)
            .map_err(|error| format!("failed to resize node {node_id}: {error}"))
    }

    fn run_blocking_inner(
        &self,
        app: &AppHandle,
        provider: ProviderConfig,
        task: PtyTask,
        node_id: String,
    ) -> Result<PtyRunOutcome, String> {
        validate_provider_for_execution(&provider)?;
        let completion_pattern = compile_pattern(&provider.completion_pattern, "completion", &provider.name)?;
        let error_pattern = compile_pattern(&provider.error_pattern, "error", &provider.name)?;
        let mut detector = CompletionDetector::new(
            completion_pattern,
            error_pattern,
            provider.effective_settle_ms(),
            DEFAULT_TAIL_WINDOW_BYTES,
        );
        let mut buffer = BoundedBuffer::new(provider.effective_max_output_bytes());
        let pty_size = normalize_pty_size(
            task.cols.unwrap_or(provider.cols),
            task.rows.unwrap_or(provider.rows),
        );
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(pty_size)
            .map_err(|error| format!("failed to open PTY: {error}"))?;

        let mut command = CommandBuilder::new(&provider.command);
        command.args(&provider.args);
        for (key, value) in &provider.env {
            command.env(key, value);
        }
        for (key, value) in &task.env {
            command.env(key, value);
        }
        command.env("COLUMNS", pty_size.cols.to_string());
        command.env("LINES", pty_size.rows.to_string());
        if let Some(workdir) = &task.workdir {
            command.cwd(workdir);
        }

        let materialized_prompt = PromptMaterialization::new(&task, &node_id)?;
        let prompt = prompt_for_provider(&provider, &materialized_prompt.prompt);
        if provider.input_mode == ProviderInputMode::AppendArg {
            command.arg(&prompt);
        }

        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| format!("failed to spawn {}: {error}", provider.name))?;

        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| format!("failed to clone PTY reader: {error}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| format!("failed to take PTY writer: {error}"))?;
        let writer = Arc::new(Mutex::new(writer));
        let killer = Arc::new(Mutex::new(child.clone_killer()));
        let master = Arc::new(Mutex::new(pair.master));

        self.active
            .lock()
            .map_err(|_| "failed to lock PTY sessions".to_string())?
            .insert(
                node_id.clone(),
                ActiveSession {
                    master: Arc::clone(&master),
                    writer: Arc::clone(&writer),
                    killer: Arc::clone(&killer),
                },
            );

        if provider.input_mode == ProviderInputMode::Stdin {
            let mut writer = writer
                .lock()
                .map_err(|_| format!("failed to lock writer for node: {node_id}"))?;
            writer
                .write_all(prompt.as_bytes())
                .and_then(|_| writer.write_all(b"\n"))
                .and_then(|_| writer.flush())
                .map_err(|error| format!("failed to send prompt to node {node_id}: {error}"))?;
        }

        let (reader_tx, reader_rx) = mpsc::channel::<ReaderEvent>();
        thread::spawn(move || {
            let mut buffer = [0_u8; 4096];
            let mut decoder = Utf8StreamDecoder::default();
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => {
                        let chunk = decoder.finish();
                        if !chunk.is_empty() && reader_tx.send(ReaderEvent::Data(chunk)).is_err() {
                            break;
                        }
                        let _ = reader_tx.send(ReaderEvent::Eof);
                        break;
                    }
                    Ok(n) => {
                        let chunk = decoder.decode(&buffer[..n]);
                        if !chunk.is_empty() && reader_tx.send(ReaderEvent::Data(chunk)).is_err() {
                            break;
                        }
                    }
                    Err(error) => {
                        let _ = reader_tx.send(ReaderEvent::Error(error.to_string()));
                        break;
                    }
                }
            }
        });

        let timeout =
            Duration::from_millis(task.timeout_ms.unwrap_or(provider.completion_timeout_ms));
        let idle_timeout = Duration::from_millis(provider.idle_timeout_ms);
        let started_at = Instant::now();
        let mut last_output_at = Instant::now();
        let mut exit_code = None;
        let mut timed_out = false;
        let mut error_class: Option<ErrorClass> = None;
        let mut completion_seen = false;

        let completion_reason = loop {
            match reader_rx.recv_timeout(Duration::from_millis(50)) {
                Ok(ReaderEvent::Data(chunk)) => {
                    last_output_at = Instant::now();
                    buffer.append(&chunk);
                    let _ = app.emit(
                        "pty:data",
                        PtyDataPayload {
                            node_id: node_id.clone(),
                            chunk: chunk.clone(),
                        },
                    );

                    if let Some(detection) = detector.push(&chunk) {
                        match detection.kind {
                            DetectionKind::Error => {
                                error_class = Some(CompletionDetector::classify_error_in_chunk(
                                    &chunk,
                                    &provider.error_pattern,
                                ));
                                break "provider-error".to_string();
                            }
                            DetectionKind::Completion => {
                                completion_seen = true;
                            }
                        }
                    }
                }
                Ok(ReaderEvent::Eof) => {
                    break if completion_seen {
                        "completion-pattern".to_string()
                    } else {
                        "eof".to_string()
                    };
                }
                Ok(ReaderEvent::Error(error)) => {
                    return Err(format!("failed to read from node {node_id}: {error}"));
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    break if completion_seen {
                        "completion-pattern".to_string()
                    } else {
                        "reader-disconnected".to_string()
                    };
                }
            }

            if detector.is_settled(last_output_at) {
                break "completion-pattern".to_string();
            }

            match child.try_wait() {
                Ok(Some(status)) => {
                    exit_code = Some(status.exit_code());
                    // If the completion pattern fired before the process exited,
                    // preserve that semantic — the work was done before exit, not
                    // accidentally because the process exited.
                    break if completion_seen {
                        "completion-pattern".to_string()
                    } else {
                        "process-exit".to_string()
                    };
                }
                Ok(None) => {}
                Err(error) => return Err(format!("failed to poll node {node_id}: {error}")),
            }

            if started_at.elapsed() > timeout {
                timed_out = true;
                break "timeout-fallback".to_string();
            }

            if buffer.byte_length() > 0 && last_output_at.elapsed() > idle_timeout {
                timed_out = true;
                break "idle-timeout-fallback".to_string();
            }
        };

        if exit_code.is_none() {
            match child.try_wait() {
                Ok(Some(status)) => exit_code = Some(status.exit_code()),
                Ok(None) => {
                    let _ = child.kill();
                    if let Ok(status) = child.wait() {
                        exit_code = Some(status.exit_code());
                    }
                }
                Err(_) => {}
            }
        }

        let _ = self
            .active
            .lock()
            .map_err(|_| "failed to lock PTY sessions".to_string())?
            .remove(&node_id);

        let raw_output = buffer.to_string_value();
        Ok(PtyRunOutcome {
            node_id,
            result: normalize_display_text(&strip_ansi(&raw_output))
                .trim()
                .to_string(),
            completion_reason,
            exit_code,
            timed_out,
            truncated: buffer.was_truncated(),
            error_class,
        })
    }
}

fn compile_pattern(
    pattern: &str,
    kind: &str,
    provider_name: &str,
) -> Result<Option<Regex>, String> {
    let trimmed = pattern.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    Regex::new(trimmed).map(Some).map_err(|error| {
        format!("invalid {kind} pattern for {provider_name}: {error}")
    })
}

fn normalize_pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn prompt_for_provider(provider: &ProviderConfig, prompt: &str) -> String {
    if provider.name == "shell" && provider.input_mode == ProviderInputMode::AppendArg {
        format!(
            "{prompt}\nloom_status=$?\nprintf '\\nLOOM_EXIT:%s\\n' \"$loom_status\"\nexit \"$loom_status\""
        )
    } else {
        prompt.to_string()
    }
}

const INLINE_PROMPT_BYTE_LIMIT: usize = 12 * 1024;

struct PromptMaterialization {
    prompt: String,
    path: Option<PathBuf>,
}

impl PromptMaterialization {
    fn new(task: &PtyTask, node_id: &str) -> Result<Self, String> {
        if task.prompt.len() <= INLINE_PROMPT_BYTE_LIMIT {
            return Ok(Self {
                prompt: task.prompt.clone(),
                path: None,
            });
        }

        let base_dir = task
            .workdir
            .as_ref()
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
        let prompt_dir = base_dir.join(".omx").join("tmp").join("prompts");
        fs::create_dir_all(&prompt_dir).map_err(|error| {
            format!(
                "failed to create prompt handoff directory {}: {error}",
                prompt_dir.display()
            )
        })?;

        let path = prompt_dir.join(format!("{node_id}.txt"));
        fs::write(&path, &task.prompt).map_err(|error| {
            format!("failed to write prompt handoff {}: {error}", path.display())
        })?;

        Ok(Self {
            prompt: format!(
                "The task prompt is too large for safe inline PTY input. Read the full UTF-8 instructions from this file, then complete them: {}",
                path.display()
            ),
            path: Some(path),
        })
    }
}

impl Drop for PromptMaterialization {
    fn drop(&mut self) {
        if let Some(path) = &self.path {
            let _ = fs::remove_file(path);
        }
    }
}

fn generate_node_id() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    format!("node-{millis}")
}

#[cfg(test)]
mod tests {
    use super::{prompt_for_provider, PromptMaterialization, INLINE_PROMPT_BYTE_LIMIT};
    use crate::pty::providers::{default_provider_configs, ProviderInputMode};
    use crate::pty::text::normalize_display_text;
    use crate::pty::utf8::Utf8StreamDecoder;
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    use regex::Regex;
    use std::{
        io::Read,
        time::{Duration, Instant},
    };

    #[test]
    fn shell_prompt_adds_completion_marker() {
        let shell = default_provider_configs()
            .unwrap()
            .into_iter()
            .find(|provider| provider.name == "shell")
            .unwrap();

        let prompt = prompt_for_provider(&shell, "echo ok");

        assert!(prompt.contains("LOOM_EXIT"));
        assert_eq!(shell.input_mode, ProviderInputMode::AppendArg);
    }

    #[test]
    fn materializes_large_prompts_to_workspace_file() {
        let task = super::PtyTask {
            node_id: Some("large-prompt-test".to_string()),
            provider: "claude-code".to_string(),
            prompt: "한".repeat(INLINE_PROMPT_BYTE_LIMIT),
            workdir: Some(std::env::current_dir().unwrap().display().to_string()),
            env: Default::default(),
            timeout_ms: None,
            cols: None,
            rows: None,
        };
        let materialized = PromptMaterialization::new(&task, "large-prompt-test").unwrap();
        let path = materialized.path.clone().unwrap();

        assert!(materialized
            .prompt
            .contains(path.to_string_lossy().as_ref()));
        assert!(path.exists());
        drop(materialized);
        assert!(!path.exists());
    }

    #[test]
    fn portable_pty_shell_smoke_reads_completion_marker() {
        let shell = default_provider_configs()
            .unwrap()
            .into_iter()
            .find(|provider| provider.name == "shell")
            .unwrap();
        let pattern = Regex::new(&shell.completion_pattern).unwrap();
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: shell.rows,
                cols: shell.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();

        let mut command = CommandBuilder::new(&shell.command);
        command.args(&shell.args);
        command.arg(prompt_for_provider(&shell, "printf 'loom-smoke 한글'"));

        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().unwrap();
        let started_at = Instant::now();
        let mut output = String::new();
        let mut buffer = [0_u8; 1024];
        let mut decoder = Utf8StreamDecoder::default();

        while started_at.elapsed() < Duration::from_secs(5) {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    output.push_str(&decoder.decode(&buffer[..n]));
                    if pattern.is_match(&output) {
                        break;
                    }
                }
                Err(error) => panic!("failed to read smoke PTY: {error}"),
            }
        }

        let _ = child.kill();
        output.push_str(&normalize_display_text(&decoder.finish()));
        assert!(output.contains("loom-smoke 한글"));
        assert!(
            pattern.is_match(&output),
            "completion marker not found in {output:?}"
        );
    }
}
