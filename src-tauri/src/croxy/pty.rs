use anyhow::{Context, Result, bail};
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PtyCommand {
    pub program: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub cwd: PathBuf,
}

impl PtyCommand {
    pub fn claude(args: Vec<String>, env: HashMap<String, String>, cwd: &Path) -> Self {
        Self {
            program: "claude".to_string(),
            args,
            env,
            cwd: cwd.to_path_buf(),
        }
    }

    fn into_builder(self, program: impl AsRef<Path>) -> CommandBuilder {
        let mut builder = CommandBuilder::new(program.as_ref());
        builder.args(self.args);
        builder.cwd(self.cwd);
        for (key, value) in self.env {
            builder.env(key, value);
        }
        builder
    }
}

pub trait PtyWriter {
    fn write(&mut self, data: &str);
}

pub trait PtyKiller {
    fn kill(&mut self, signal: Option<&str>);
}

pub trait PtyHandle: PtyWriter + PtyKiller {
    fn resize(&mut self, cols: u16, rows: u16) -> Result<()>;
    fn pid(&self) -> Option<u32>;
}

impl<T> PtyWriter for Box<T>
where
    T: PtyWriter + ?Sized,
{
    fn write(&mut self, data: &str) {
        (**self).write(data);
    }
}

impl<T> PtyKiller for Box<T>
where
    T: PtyKiller + ?Sized,
{
    fn kill(&mut self, signal: Option<&str>) {
        (**self).kill(signal);
    }
}

impl<T> PtyHandle for Box<T>
where
    T: PtyHandle + ?Sized,
{
    fn resize(&mut self, cols: u16, rows: u16) -> Result<()> {
        (**self).resize(cols, rows)
    }

    fn pid(&self) -> Option<u32> {
        (**self).pid()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Windows,
    Posix,
}

impl Platform {
    pub fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else {
            Self::Posix
        }
    }
}

const BRACKETED_PASTE_OPEN: &str = "\x1b[200~";
const BRACKETED_PASTE_CLOSE: &str = "\x1b[201~";

pub fn normalize_pty_kill_signal(signal: Option<&str>, platform: Platform) -> Option<String> {
    match platform {
        Platform::Windows => None,
        Platform::Posix => signal.map(str::to_string),
    }
}

pub fn sanitize_prompt_text(text: &str) -> String {
    text.replace(BRACKETED_PASTE_OPEN, "")
        .replace(BRACKETED_PASTE_CLOSE, "")
}

pub fn send_prompt(handle: &mut impl PtyWriter, text: &str) {
    let safe_text = sanitize_prompt_text(text);
    if safe_text.contains('\n') {
        handle.write(&format!(
            "{BRACKETED_PASTE_OPEN}{safe_text}{BRACKETED_PASTE_CLOSE}"
        ));
    } else {
        handle.write(&safe_text);
    }
    handle.write("\r");
}

pub fn send_interrupt(handle: &mut impl PtyWriter) {
    handle.write("\x1b");
}

pub fn send_permission_allow(handle: &mut impl PtyWriter) {
    handle.write("\r");
}

pub fn send_permission_deny(handle: &mut impl PtyWriter) {
    handle.write("\x1b");
}

pub fn send_slash_command(handle: &mut impl PtyWriter, command: &str) {
    handle.write(&format!("/{command}\r"));
}

pub fn find_claude_in_path() -> Result<PathBuf> {
    let path = std::env::var_os("PATH").context("PATH is not set")?;
    let candidates = std::env::split_paths(&path).flat_map(|dir| {
        if cfg!(windows) {
            vec![dir.join("claude.cmd"), dir.join("claude.exe")]
        } else {
            vec![dir.join("claude")]
        }
    });

    for candidate in candidates {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }

    if cfg!(windows) {
        bail!(
            "claude not found. Install Claude Code first: https://docs.anthropic.com/en/docs/claude-code"
        );
    }
    bail!(
        "claude not found in PATH. Install Claude Code first: https://docs.anthropic.com/en/docs/claude-code"
    );
}

pub struct PortablePtyHandle {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    pid: Option<u32>,
    child_exited: Arc<AtomicBool>,
}

impl std::fmt::Debug for PortablePtyHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PortablePtyHandle")
            .field("pid", &self.pid())
            .finish_non_exhaustive()
    }
}

impl PtyWriter for PortablePtyHandle {
    fn write(&mut self, data: &str) {
        let _ = self.writer.write_all(data.as_bytes());
        let _ = self.writer.flush();
    }
}

impl PtyKiller for PortablePtyHandle {
    fn kill(&mut self, _signal: Option<&str>) {
        let _ = self.killer.kill();
    }
}

impl PtyHandle for PortablePtyHandle {
    fn resize(&mut self, cols: u16, rows: u16) -> Result<()> {
        self.master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
    }

    fn pid(&self) -> Option<u32> {
        self.pid
    }
}

impl Drop for PortablePtyHandle {
    fn drop(&mut self) {
        if should_kill_child_on_drop(self.child_exited.load(Ordering::Relaxed)) {
            let _ = self.killer.kill();
        }
    }
}

pub type PtyDataCallback = Box<dyn FnMut(String) + Send + 'static>;
pub type PtyExitCallback = Box<dyn FnOnce(u32, Option<String>) + Send + 'static>;

pub fn spawn_claude(
    command: PtyCommand,
    on_data: PtyDataCallback,
    on_exit: PtyExitCallback,
) -> Result<PortablePtyHandle> {
    spawn_claude_with_program(command, find_claude_in_path()?, on_data, on_exit)
}

pub fn spawn_claude_with_program(
    command: PtyCommand,
    program: impl AsRef<Path>,
    mut on_data: PtyDataCallback,
    on_exit: PtyExitCallback,
) -> Result<PortablePtyHandle> {
    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize {
        rows: 24,
        cols: 120,
        pixel_width: 0,
        pixel_height: 0,
    })?;

    let reader = pair.master.try_clone_reader()?;
    let writer = pair.master.take_writer()?;
    let mut child = pair
        .slave
        .spawn_command(command.into_builder(program))
        .context("failed to spawn claude in PTY")?;
    let pid = child.process_id();
    let exit_killer = child.clone_killer();
    let child_exited = Arc::new(AtomicBool::new(false));
    let exit_child_exited = Arc::clone(&child_exited);

    thread::spawn(move || {
        read_pty_output(reader, &mut on_data);
    });
    thread::spawn(move || {
        let status = child.wait();
        exit_child_exited.store(true, Ordering::Relaxed);
        match status {
            Ok(status) => on_exit(status.exit_code(), status.signal().map(str::to_string)),
            Err(_) => on_exit(1, None),
        }
    });

    Ok(PortablePtyHandle {
        master: pair.master,
        writer,
        killer: exit_killer,
        pid,
        child_exited,
    })
}

fn should_kill_child_on_drop(child_exited: bool) -> bool {
    !child_exited
}

fn read_pty_output(mut reader: Box<dyn Read + Send>, on_data: &mut PtyDataCallback) {
    let mut buffer = [0_u8; 8192];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(len) => on_data(String::from_utf8_lossy(&buffer[..len]).to_string()),
            Err(_) => break,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct MockHandle {
        writes: Vec<String>,
    }

    impl PtyWriter for MockHandle {
        fn write(&mut self, data: &str) {
            self.writes.push(data.to_string());
        }
    }

    #[test]
    fn sends_single_line_prompt_with_carriage_return() {
        let mut handle = MockHandle::default();

        send_prompt(&mut handle, "hello world");

        assert_eq!(handle.writes, vec!["hello world", "\r"]);
    }

    #[test]
    fn uses_bracketed_paste_for_multi_line_prompt() {
        let mut handle = MockHandle::default();

        send_prompt(&mut handle, "line1\nline2");

        assert_eq!(handle.writes, vec!["\x1b[200~line1\nline2\x1b[201~", "\r"]);
    }

    #[test]
    fn strips_bracketed_paste_delimiters_from_prompt_text() {
        let mut handle = MockHandle::default();

        send_prompt(&mut handle, "line1\n\x1b[201~escaped\n\x1b[200~line2");

        assert_eq!(
            handle.writes,
            vec!["\x1b[200~line1\nescaped\nline2\x1b[201~", "\r"]
        );
    }

    #[test]
    fn sends_interrupt_and_permission_keypresses() {
        let mut handle = MockHandle::default();

        send_interrupt(&mut handle);
        send_permission_allow(&mut handle);
        send_permission_deny(&mut handle);

        assert_eq!(handle.writes, vec!["\x1b", "\r", "\x1b"]);
    }

    #[test]
    fn cleanup_kills_child_only_when_it_has_not_exited() {
        assert!(should_kill_child_on_drop(false));
        assert!(!should_kill_child_on_drop(true));
    }

    #[test]
    fn sends_slash_command_with_carriage_return() {
        let mut handle = MockHandle::default();

        send_slash_command(&mut handle, "model claude-sonnet-4-6");

        assert_eq!(handle.writes, vec!["/model claude-sonnet-4-6\r"]);
    }

    #[test]
    fn normalizes_kill_signal_by_platform() {
        assert_eq!(
            normalize_pty_kill_signal(Some("SIGTERM"), Platform::Windows),
            None
        );
        assert_eq!(
            normalize_pty_kill_signal(Some("SIGTERM"), Platform::Posix),
            Some("SIGTERM".to_string())
        );
        assert_eq!(normalize_pty_kill_signal(None, Platform::Posix), None);
    }

    #[test]
    fn builds_claude_command_with_cwd_and_env() {
        let cwd = PathBuf::from("/tmp");
        let command = PtyCommand::claude(
            vec!["--model".to_string(), "sonnet".to_string()],
            HashMap::from([(
                "ANTHROPIC_BASE_URL".to_string(),
                "http://127.0.0.1:1234".to_string(),
            )]),
            &cwd,
        );

        assert_eq!(command.program, "claude");
        assert_eq!(command.args, vec!["--model", "sonnet"]);
        assert_eq!(command.cwd, cwd);
        assert_eq!(
            command.env.get("ANTHROPIC_BASE_URL").map(String::as_str),
            Some("http://127.0.0.1:1234")
        );
    }
}
