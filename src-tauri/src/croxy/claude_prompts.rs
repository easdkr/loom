pub fn strip_terminal_controls(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch == '\r' {
            output.push('\n');
            continue;
        }
        if ch != '\x1b' {
            output.push(ch);
            continue;
        }

        match chars.peek().copied() {
            Some('[') => {
                chars.next();
                for next in chars.by_ref() {
                    if ('@'..='~').contains(&next) {
                        break;
                    }
                }
            }
            Some(']') => {
                chars.next();
                let mut previous_was_escape = false;
                for next in chars.by_ref() {
                    if next == '\x07' || (previous_was_escape && next == '\\') {
                        break;
                    }
                    previous_was_escape = next == '\x1b';
                }
            }
            Some('P' | 'X' | '^' | '_') => {
                chars.next();
                let mut previous_was_escape = false;
                for next in chars.by_ref() {
                    if previous_was_escape && next == '\\' {
                        break;
                    }
                    previous_was_escape = next == '\x1b';
                }
            }
            Some('@'..='_') => {
                chars.next();
            }
            _ => {}
        }
    }

    output
}

pub fn is_workspace_trust_prompt(text: &str) -> bool {
    let compact: String = strip_terminal_controls(text)
        .to_lowercase()
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .collect();
    compact.contains("quicksafetycheck")
        && compact.contains("yesitrustthisfolder")
        && compact.contains("noexit")
}

pub fn should_auto_confirm_workspace_trust(claude_args: &[String]) -> bool {
    claude_args
        .iter()
        .any(|arg| arg == "--dangerously-skip-permissions")
}

#[derive(Debug, Default)]
pub struct WorkspaceTrustPromptDetector {
    buffer: String,
    detected: bool,
}

impl WorkspaceTrustPromptDetector {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, data: &str) -> bool {
        if self.detected {
            return false;
        }
        self.buffer.push_str(data);
        if self.buffer.len() > 16_000 {
            let remove_until = self.buffer.len() - 16_000;
            let remove_until = self
                .buffer
                .char_indices()
                .map(|(idx, _)| idx)
                .find(|idx| *idx >= remove_until)
                .unwrap_or(self.buffer.len());
            self.buffer.drain(..remove_until);
        }
        if is_workspace_trust_prompt(&self.buffer) {
            self.detected = true;
            return true;
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TRUST_PROMPT: &str = r#"
Accessing workspace:

 /Users/dn

 Quick safety check: Is this a project you created or one you trust?

 Claude Code'll be able to read, edit, and execute files here.

 > 1. Yes, I trust this folder
   2. No, exit

 Enter to confirm - Esc to cancel
"#;

    #[test]
    fn strips_terminal_controls() {
        assert_eq!(
            strip_terminal_controls("\x1b[32mhello\x1b[0m\rworld"),
            "hello\nworld"
        );
    }

    #[test]
    fn detects_workspace_trust_prompt() {
        assert!(is_workspace_trust_prompt(TRUST_PROMPT));
    }

    #[test]
    fn detects_compact_terminal_rendered_trust_prompt_text() {
        assert!(is_workspace_trust_prompt(
            r#"
            Accessingworkspace:
            /Users/dn
            Quicksafetycheck:Isthisaprojectyoucreatedoroneyoutrust?
            >1.Yes,Itrustthisfolder
            2.No,exit
            Entertoconfirm-Esctocancel
            "#
        ));
    }

    #[test]
    fn does_not_detect_unrelated_output() {
        assert!(!is_workspace_trust_prompt("Hi! What can I help you with?"));
    }

    #[test]
    fn auto_confirms_only_for_explicit_permission_bypass() {
        assert!(should_auto_confirm_workspace_trust(&[
            "--dangerously-skip-permissions".to_string()
        ]));
        assert!(!should_auto_confirm_workspace_trust(&[
            "--permission-mode".to_string(),
            "bypassPermissions".to_string()
        ]));
        assert!(!should_auto_confirm_workspace_trust(&["hello".to_string()]));
    }

    #[test]
    fn detector_fires_once_across_chunks() {
        let mut detector = WorkspaceTrustPromptDetector::new();

        assert!(!detector.push(&TRUST_PROMPT[..120]));
        assert!(detector.push(&TRUST_PROMPT[120..]));
        assert!(!detector.push(TRUST_PROMPT));
    }

    #[test]
    fn detector_trims_without_splitting_utf8() {
        let mut detector = WorkspaceTrustPromptDetector::new();

        assert!(!detector.push(&format!("{}한", "x".repeat(16_001))));
        assert!(detector.buffer.is_char_boundary(0));
        assert!(detector.buffer.is_char_boundary(detector.buffer.len()));
    }
}
