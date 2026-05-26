use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;

const DEFAULT_INITIAL_READ_BYTES: u64 = 512 * 1024;

#[derive(Debug, Clone)]
pub struct TranscriptObserver {
    transcript_path: PathBuf,
    initial_read_bytes: u64,
    offset: Option<u64>,
    pending: String,
    seen_uuids: HashSet<String>,
}

impl TranscriptObserver {
    pub fn new(transcript_path: impl Into<PathBuf>) -> Self {
        Self {
            transcript_path: transcript_path.into(),
            initial_read_bytes: DEFAULT_INITIAL_READ_BYTES,
            offset: None,
            pending: String::new(),
            seen_uuids: HashSet::new(),
        }
    }

    pub fn with_initial_read_bytes(mut self, initial_read_bytes: u64) -> Self {
        self.initial_read_bytes = initial_read_bytes;
        self
    }

    pub fn poll(&mut self) -> Vec<Value> {
        let Ok(stat) = fs::metadata(&self.transcript_path) else {
            return Vec::new();
        };
        let mut skip_leading_partial_line = false;
        let offset = match self.offset {
            Some(offset) if stat.len() < offset => {
                self.pending.clear();
                0
            }
            Some(offset) => offset,
            None => {
                let offset = stat.len().saturating_sub(self.initial_read_bytes);
                skip_leading_partial_line = offset > 0;
                offset
            }
        };

        if stat.len() <= offset {
            self.offset = Some(offset);
            return Vec::new();
        }

        let Ok(bytes) = fs::read(&self.transcript_path) else {
            return Vec::new();
        };
        let start = offset as usize;
        let mut chunk = String::from_utf8_lossy(&bytes[start..]).into_owned();
        if skip_leading_partial_line {
            chunk = chunk
                .find('\n')
                .map(|idx| chunk[idx + 1..].to_string())
                .unwrap_or_default();
        }
        self.offset = Some(stat.len());
        self.process_chunk(&chunk)
    }

    fn process_chunk(&mut self, chunk: &str) -> Vec<Value> {
        if chunk.is_empty() {
            return Vec::new();
        }
        let combined = format!("{}{}", self.pending, chunk);
        let mut parts: Vec<&str> = combined.split('\n').collect();
        self.pending = parts.pop().unwrap_or_default().to_string();

        let mut events = Vec::new();
        for part in parts {
            let Ok(event) = serde_json::from_str::<Value>(part.trim()) else {
                continue;
            };
            if !event.is_object() {
                continue;
            }
            if let Some(uuid) = event.get("uuid").and_then(Value::as_str)
                && !uuid.is_empty()
                && !self.seen_uuids.insert(uuid.to_string())
            {
                continue;
            }
            events.push(event);
        }
        events
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

    struct TempFile {
        path: PathBuf,
    }

    impl TempFile {
        fn new() -> Self {
            let id = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
            let dir =
                std::env::temp_dir().join(format!("croxy-transcript-{}-{id}", std::process::id()));
            fs::create_dir_all(&dir).unwrap();
            let path = dir.join("session.jsonl");
            fs::write(&path, "").unwrap();
            Self { path }
        }
    }

    impl Drop for TempFile {
        fn drop(&mut self) {
            if let Some(parent) = self.path.parent() {
                let _ = fs::remove_dir_all(parent);
            }
        }
    }

    #[test]
    fn emits_complete_jsonl_records_and_waits_for_partials() {
        let file = TempFile::new();
        fs::write(
            &file.path,
            json!({"uuid":"one","type":"system"}).to_string() + "\n",
        )
        .unwrap();
        let mut observer = TranscriptObserver::new(&file.path);

        assert_eq!(observer.poll()[0]["uuid"], "one");

        fs::write(&file.path, "{\"uuid\":\"two\",\"type\":\"system\"").unwrap();
        assert!(observer.poll().is_empty());

        fs::write(&file.path, "{\"uuid\":\"two\",\"type\":\"system\"}\n").unwrap();
        assert_eq!(observer.poll()[0]["uuid"], "two");
    }

    #[test]
    fn dedupes_records_by_uuid() {
        let file = TempFile::new();
        let mut observer = TranscriptObserver::new(&file.path);
        assert!(observer.poll().is_empty());

        fs::write(
            &file.path,
            [
                json!({"uuid":"same","value":1}).to_string(),
                json!({"uuid":"same","value":2}).to_string(),
            ]
            .join("\n")
                + "\n",
        )
        .unwrap();
        let events = observer.poll();
        assert_eq!(events, vec![json!({"uuid":"same","value":1})]);
    }

    #[test]
    fn skips_partial_first_line_when_starting_from_capped_tail() {
        let file = TempFile::new();
        fs::write(
            &file.path,
            json!({"uuid":"old","value":"x".repeat(200)}).to_string()
                + "\n"
                + &json!({"uuid":"new","value":1}).to_string()
                + "\n",
        )
        .unwrap();
        let mut observer = TranscriptObserver::new(&file.path).with_initial_read_bytes(40);

        assert_eq!(observer.poll(), vec![json!({"uuid":"new","value":1})]);
    }
}
