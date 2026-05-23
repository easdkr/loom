use super::ansi::strip_ansi;
use regex::Regex;
use std::time::{Duration, Instant};

pub const DEFAULT_TAIL_WINDOW_BYTES: usize = 32 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DetectionKind {
    Completion,
    Error,
}

#[derive(Debug, Clone)]
pub struct Detection {
    pub kind: DetectionKind,
    #[allow(dead_code)] // Read by tests; kept for callers that want timing info.
    pub matched_at: Instant,
}

/// Incremental completion / error detector.
///
/// Holds a fixed-size raw tail and matches `completion_pattern` / `error_pattern`
/// against the stripped tail — O(tail) per chunk regardless of total session
/// length. Completion is gated by a settle window so a momentary "looks-done"
/// echo cannot finalize the session.
pub struct CompletionDetector {
    completion_pattern: Option<Regex>,
    error_pattern: Option<Regex>,
    tail: String,
    tail_window_bytes: usize,
    settle_for: Duration,
    completion_matched_at: Option<Instant>,
    error_matched_at: Option<Instant>,
}

impl CompletionDetector {
    pub fn new(
        completion_pattern: Option<Regex>,
        error_pattern: Option<Regex>,
        settle_ms: u64,
        tail_window_bytes: usize,
    ) -> Self {
        Self {
            completion_pattern,
            error_pattern,
            tail: String::new(),
            tail_window_bytes: tail_window_bytes.max(1024),
            settle_for: Duration::from_millis(settle_ms),
            completion_matched_at: None,
            error_matched_at: None,
        }
    }

    pub fn push(&mut self, chunk: &str) -> Option<Detection> {
        if chunk.is_empty() {
            return None;
        }
        self.tail.push_str(chunk);
        if self.tail.len() > self.tail_window_bytes * 2 {
            let drop_to = self.tail.len() - self.tail_window_bytes;
            // Drop on a char boundary so we never split a UTF-8 codepoint.
            let mut cut = drop_to;
            while cut < self.tail.len() && !self.tail.is_char_boundary(cut) {
                cut += 1;
            }
            self.tail.drain(..cut);
        }

        let stripped = strip_ansi(&self.tail);

        if let Some(pattern) = &self.error_pattern {
            if pattern.is_match(&stripped) {
                let matched_at = *self
                    .error_matched_at
                    .get_or_insert_with(Instant::now);
                return Some(Detection {
                    kind: DetectionKind::Error,
                    matched_at,
                });
            }
        }

        if let Some(pattern) = &self.completion_pattern {
            if pattern.is_match(&stripped) {
                let matched_at = *self
                    .completion_matched_at
                    .get_or_insert_with(Instant::now);
                return Some(Detection {
                    kind: DetectionKind::Completion,
                    matched_at,
                });
            }
        }

        // No tail match — reset settle clock; next match starts fresh.
        self.completion_matched_at = None;
        None
    }

    /// Returns true if the most recent completion match has been silent long
    /// enough to be considered final.
    pub fn is_settled(&self, last_output_at: Instant) -> bool {
        let Some(matched_at) = self.completion_matched_at else {
            return false;
        };
        let now = Instant::now();
        now.duration_since(matched_at) >= self.settle_for
            && now.duration_since(last_output_at) >= self.settle_for
    }

    pub fn classify_error_in_chunk(chunk: &str, error_pattern_source: &str) -> ErrorClass {
        let lower = chunk.to_lowercase();
        let pattern_lower = error_pattern_source.to_lowercase();
        if lower.contains("rate")
            || lower.contains("429")
            || lower.contains("too many")
            || lower.contains("usage limit")
            || lower.contains("quota")
            || pattern_lower.contains("rate")
            || pattern_lower.contains("quota")
            || pattern_lower.contains("usage limit")
        {
            ErrorClass::RateLimit
        } else {
            ErrorClass::ProviderError
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorClass {
    RateLimit,
    ProviderError,
}

/// Bounded FIFO byte buffer that retains the last N bytes of streamed output.
/// Records whether truncation occurred so the final outcome can flag it.
pub struct BoundedBuffer {
    chunks: Vec<String>,
    size: usize,
    max_bytes: usize,
    truncated: bool,
}

impl BoundedBuffer {
    pub fn new(max_bytes: usize) -> Self {
        Self {
            chunks: Vec::new(),
            size: 0,
            max_bytes: max_bytes.max(4096),
            truncated: false,
        }
    }

    pub fn append(&mut self, chunk: &str) {
        if chunk.is_empty() {
            return;
        }
        self.size += chunk.len();
        self.chunks.push(chunk.to_string());

        while self.size > self.max_bytes && self.chunks.len() > 1 {
            let head = self.chunks.remove(0);
            self.size -= head.len();
            self.truncated = true;
        }
        if self.size > self.max_bytes && self.chunks.len() == 1 {
            let only = self.chunks.remove(0);
            let take_from = only.len().saturating_sub(self.max_bytes);
            let mut cut = take_from;
            while cut < only.len() && !only.is_char_boundary(cut) {
                cut += 1;
            }
            let tail = only[cut..].to_string();
            self.size = tail.len();
            self.chunks.push(tail);
            self.truncated = true;
        }
    }

    pub fn to_string_value(&self) -> String {
        self.chunks.join("")
    }

    pub fn was_truncated(&self) -> bool {
        self.truncated
    }

    pub fn byte_length(&self) -> usize {
        self.size
    }
}

#[cfg(test)]
mod tests {
    use super::{BoundedBuffer, CompletionDetector, DetectionKind, ErrorClass};
    use regex::Regex;
    use std::{thread, time::Duration};

    #[test]
    fn detects_completion_on_tail() {
        let mut detector = CompletionDetector::new(
            Some(Regex::new(r"(?m)^LOOM_EXIT:\d+$").unwrap()),
            None,
            100,
            4096,
        );
        assert!(detector.push("hello world\n").is_none());
        let detection = detector.push("more text\nLOOM_EXIT:0\n").unwrap();
        assert_eq!(detection.kind, DetectionKind::Completion);
    }

    #[test]
    fn detects_error_before_completion() {
        let mut detector = CompletionDetector::new(
            Some(Regex::new(r"Done").unwrap()),
            Some(Regex::new(r"(?i)rate.?limit").unwrap()),
            100,
            4096,
        );
        let detection = detector.push("hit rate-limit then Done\n").unwrap();
        assert_eq!(detection.kind, DetectionKind::Error);
    }

    #[test]
    fn settle_requires_quiet_window() {
        let mut detector = CompletionDetector::new(
            Some(Regex::new(r"Done").unwrap()),
            None,
            50,
            4096,
        );
        let detection = detector.push("Done\n").unwrap();
        let matched_at = detection.matched_at;
        assert!(!detector.is_settled(matched_at));
        thread::sleep(Duration::from_millis(80));
        assert!(detector.is_settled(matched_at));
    }

    #[test]
    fn tail_eviction_resets_completion() {
        let mut detector = CompletionDetector::new(
            Some(Regex::new(r"Done").unwrap()),
            None,
            50,
            1024,
        );
        let first = detector.push("Done\n").unwrap();
        let payload = "x".repeat(4096);
        let after = detector.push(&payload);
        assert!(after.is_none(), "tail eviction should clear settle clock");
        let later = detector.push("Done\n").unwrap();
        assert_ne!(later.matched_at, first.matched_at);
    }

    #[test]
    fn bounded_buffer_keeps_recent_bytes() {
        let mut buffer = BoundedBuffer::new(4096);
        buffer.append(&"a".repeat(2048));
        assert!(!buffer.was_truncated());
        buffer.append(&"b".repeat(4096));
        assert!(buffer.was_truncated());
        assert!(buffer.byte_length() <= 4096);
        let value = buffer.to_string_value();
        assert!(value.ends_with('b'));
    }

    #[test]
    fn classifies_rate_limit_errors() {
        assert_eq!(
            CompletionDetector::classify_error_in_chunk("HTTP 429 Too Many Requests", ""),
            ErrorClass::RateLimit,
        );
        assert_eq!(
            CompletionDetector::classify_error_in_chunk("usage limit reached", ""),
            ErrorClass::RateLimit,
        );
        assert_eq!(
            CompletionDetector::classify_error_in_chunk("generic provider failure", ""),
            ErrorClass::ProviderError,
        );
    }
}
