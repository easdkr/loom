use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PidFileData {
    pub pid: u32,
    pub session_id: String,
    pub cwd: String,
    pub kind: String,
    pub status: Option<String>,
    pub waiting_for: Option<String>,
    pub updated_at: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusChange {
    pub status: String,
    pub waiting_for: Option<String>,
    pub data: PidFileData,
}

#[derive(Debug, Clone)]
pub struct PidWatcher {
    pid_file_path: PathBuf,
    home_dir: PathBuf,
    last_status: Option<String>,
    last_waiting_for: Option<String>,
}

impl PidWatcher {
    pub fn new(pid: u32) -> Self {
        Self::with_home_dir(pid, default_home_dir())
    }

    pub fn with_home_dir(pid: u32, home_dir: impl Into<PathBuf>) -> Self {
        let home_dir = home_dir.into();
        let pid_file_path = home_dir
            .join(".claude")
            .join("sessions")
            .join(format!("{pid}.json"));
        Self {
            pid_file_path,
            home_dir,
            last_status: None,
            last_waiting_for: None,
        }
    }

    pub fn poll(&mut self) -> Option<StatusChange> {
        let data = self.read_pid_file()?;
        let status = data.status.clone().unwrap_or_else(|| "unknown".to_string());
        let waiting_for = data.waiting_for.clone();
        if self.last_status.as_deref() == Some(&status)
            && self.last_waiting_for.as_deref() == waiting_for.as_deref()
        {
            return None;
        }
        self.last_status = Some(status.clone());
        self.last_waiting_for = waiting_for.clone();
        Some(StatusChange {
            status,
            waiting_for,
            data,
        })
    }

    pub fn get_session_id(&self) -> Option<String> {
        let session_id = self.read_pid_file()?.session_id;
        is_safe_session_id(&session_id).then_some(session_id)
    }

    pub fn get_transcript_path(&self) -> Option<PathBuf> {
        let data = self.read_pid_file()?;
        if !is_safe_session_id(&data.session_id) {
            return None;
        }

        let projects_dir = self.home_dir.join(".claude").join("projects");
        let direct = projects_dir
            .join(project_slug(&data.cwd))
            .join(format!("{}.jsonl", data.session_id));
        if direct.exists() {
            return Some(direct);
        }

        for entry in fs::read_dir(projects_dir).ok()? {
            let entry = entry.ok()?;
            let candidate = entry.path().join(format!("{}.jsonl", data.session_id));
            if candidate.exists() {
                return Some(candidate);
            }
        }
        None
    }

    pub fn read_transcript_init(&self) -> Option<Value> {
        let transcript_path = self.get_transcript_path()?;
        for line in read_file_prefix(&transcript_path, 64 * 1024).lines() {
            let event = parse_json_object(line)?;
            if event.get("type").and_then(Value::as_str) == Some("system")
                && event.get("subtype").and_then(Value::as_str) == Some("init")
            {
                return Some(event);
            }
        }
        None
    }

    pub fn read_transcript_events(&self, subtype: &str, from_end: u64) -> Vec<Value> {
        let Some(transcript_path) = self.get_transcript_path() else {
            return Vec::new();
        };
        read_file_suffix(&transcript_path, from_end)
            .lines()
            .filter_map(parse_json_object)
            .filter(|event| {
                event.get("type").and_then(Value::as_str) == Some("system")
                    && event.get("subtype").and_then(Value::as_str) == Some(subtype)
            })
            .collect()
    }

    fn read_pid_file(&self) -> Option<PidFileData> {
        let bytes = fs::read(&self.pid_file_path).ok()?;
        serde_json::from_slice(&bytes).ok()
    }
}

fn is_safe_session_id(session_id: &str) -> bool {
    !session_id.contains("..")
        && !session_id.is_empty()
        && session_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

fn project_slug(cwd: &str) -> String {
    format!("-{}", cwd.replace('/', "-").trim_start_matches('-'))
}

fn parse_json_object(line: &str) -> Option<Value> {
    let value: Value = serde_json::from_str(line.trim()).ok()?;
    value.is_object().then_some(value)
}

fn read_file_prefix(path: &Path, max_bytes: usize) -> String {
    let Ok(bytes) = fs::read(path) else {
        return String::new();
    };
    String::from_utf8_lossy(&bytes[..bytes.len().min(max_bytes)]).into_owned()
}

fn read_file_suffix(path: &Path, max_bytes: u64) -> String {
    let Ok(bytes) = fs::read(path) else {
        return String::new();
    };
    let start = bytes.len().saturating_sub(max_bytes as usize);
    String::from_utf8_lossy(&bytes[start..]).into_owned()
}

fn default_home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};

    const TEST_PID: u32 = 99999;
    static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

    struct TempHome {
        path: PathBuf,
    }

    impl TempHome {
        fn new() -> Self {
            let id = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
            let path =
                std::env::temp_dir().join(format!("croxy-pid-watcher-{}-{id}", std::process::id()));
            fs::create_dir_all(path.join(".claude").join("sessions")).unwrap();
            Self { path }
        }

        fn pid_file(&self) -> PathBuf {
            self.path
                .join(".claude")
                .join("sessions")
                .join(format!("{TEST_PID}.json"))
        }

        fn write_pid_file(&self, data: Value) {
            fs::write(self.pid_file(), data.to_string()).unwrap();
        }
    }

    impl Drop for TempHome {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn base_pid_file(extra: Value) -> Value {
        let mut value = json!({
            "pid": TEST_PID,
            "sessionId": "test-session-id",
            "cwd": "/tmp/test",
            "kind": "interactive"
        });
        let object = value.as_object_mut().unwrap();
        for (key, value) in extra.as_object().unwrap() {
            object.insert(key.clone(), value.clone());
        }
        value
    }

    #[test]
    fn reads_session_id_and_rejects_unsafe_ids() {
        let home = TempHome::new();
        let watcher = PidWatcher::with_home_dir(TEST_PID, &home.path);

        home.write_pid_file(base_pid_file(json!({ "sessionId": "abc-123" })));
        assert_eq!(watcher.get_session_id().as_deref(), Some("abc-123"));

        home.write_pid_file(base_pid_file(json!({ "sessionId": "../secret" })));
        assert_eq!(watcher.get_session_id(), None);
        assert_eq!(watcher.get_transcript_path(), None);
    }

    #[test]
    fn polls_status_and_waiting_for_changes_without_duplicates() {
        let home = TempHome::new();
        let mut watcher = PidWatcher::with_home_dir(TEST_PID, &home.path);

        home.write_pid_file(base_pid_file(json!({ "status": "busy" })));
        assert_eq!(watcher.poll().unwrap().status, "busy");
        assert!(watcher.poll().is_none());

        home.write_pid_file(base_pid_file(
            json!({ "status": "waiting", "waitingFor": "approve Bash" }),
        ));
        let second = watcher.poll().unwrap();
        assert_eq!(second.status, "waiting");
        assert_eq!(second.waiting_for.as_deref(), Some("approve Bash"));

        home.write_pid_file(base_pid_file(
            json!({ "status": "waiting", "waitingFor": "approve Edit" }),
        ));
        assert_eq!(
            watcher.poll().unwrap().waiting_for.as_deref(),
            Some("approve Edit")
        );
    }

    #[test]
    fn missing_status_defaults_to_unknown_and_corrupt_files_are_ignored() {
        let home = TempHome::new();
        let mut watcher = PidWatcher::with_home_dir(TEST_PID, &home.path);

        home.write_pid_file(base_pid_file(json!({})));
        assert_eq!(watcher.poll().unwrap().status, "unknown");

        fs::write(home.pid_file(), "not json{{{").unwrap();
        assert!(watcher.poll().is_none());
    }

    #[test]
    fn finds_transcript_and_reads_init_and_tail_events() {
        let home = TempHome::new();
        let watcher = PidWatcher::with_home_dir(TEST_PID, &home.path);
        home.write_pid_file(base_pid_file(json!({
            "sessionId": "sess-1",
            "cwd": "/tmp"
        })));
        let project_dir = home.path.join(".claude").join("projects").join("-tmp");
        fs::create_dir_all(&project_dir).unwrap();
        fs::write(
            project_dir.join("sess-1.jsonl"),
            [
                json!({"type":"system","subtype":"hook_started"}).to_string(),
                json!({"type":"system","subtype":"init","session_id":"sess-1","tools":["Bash"]})
                    .to_string(),
                json!({"type":"system","subtype":"post_turn_summary","title":"Done"}).to_string(),
            ]
            .join("\n")
                + "\n",
        )
        .unwrap();

        assert_eq!(
            watcher.get_transcript_path(),
            Some(project_dir.join("sess-1.jsonl"))
        );
        assert_eq!(watcher.read_transcript_init().unwrap()["subtype"], "init");
        let summaries = watcher.read_transcript_events("post_turn_summary", 4096);
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0]["title"], "Done");
    }
}
