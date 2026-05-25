use super::text::normalize_display_text;
use regex::Regex;
use std::sync::OnceLock;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentTranscript {
    pub assistant_content: String,
    pub activity: Option<String>,
    pub lines: Vec<String>,
}

const ASSISTANT_MARKERS: &[char] = &['⏺', '●', '○', '◍'];

pub fn extract_agent_transcript(lines: &[String]) -> AgentTranscript {
    let rendered_lines = rendered_lines(lines);
    let assistant_lines = dedupe_consecutive(
        rendered_lines
            .iter()
            .filter_map(|line| normalize_assistant_line(line))
            .collect(),
    );
    let assistant_content = assistant_lines.join("\n").trim().to_string();
    let activity = extract_activity(&rendered_lines);

    AgentTranscript {
        assistant_content,
        activity,
        lines: rendered_lines,
    }
}

fn rendered_lines(lines: &[String]) -> Vec<String> {
    lines
        .iter()
        .map(|line| sanitize_line(line))
        .filter(|line| !line.is_empty())
        .collect()
}

fn sanitize_line(line: &str) -> String {
    normalize_display_text(line)
        .chars()
        .filter(|ch| !is_control_text(*ch))
        .collect::<String>()
        .trim()
        .to_string()
}

fn is_control_text(ch: char) -> bool {
    matches!(ch as u32, 0x00..=0x08 | 0x0b | 0x0c | 0x0e..=0x1f | 0x7f..=0x9f)
}

fn normalize_assistant_line(line: &str) -> Option<String> {
    let text = normalize_answer_spacing(&remove_inline_status_fragments(&unwrap_box_line(line)));
    if text.is_empty() || is_chrome_line(&text) {
        return None;
    }

    let mut chars = text.chars();
    if let Some(marker) = chars.next() {
        if ASSISTANT_MARKERS.contains(&marker) {
            let content = normalize_answer_spacing(chars.as_str().trim());
            return Some(content).filter(|value| !value.is_empty() && !is_chrome_line(value));
        }
    }
    Some(text)
}

fn extract_activity(lines: &[String]) -> Option<String> {
    for line in lines.iter().rev() {
        let text = unwrap_box_line(line);
        if text.is_empty() {
            continue;
        }
        if completed_status_re().is_match(&text) {
            continue;
        }
        if transient_status_re().is_match(&text)
            || provider_status_re().is_match(&text)
            || token_counter_re().is_match(&text)
        {
            return Some(text);
        }
        if !is_chrome_line(&text) {
            return None;
        }
    }
    None
}

fn unwrap_box_line(line: &str) -> String {
    let trimmed = line.trim();
    let mut chars = trimmed.chars();
    let first = chars.next();
    let last = trimmed.chars().last();
    if matches!(first, Some('│' | '┃')) && matches!(last, Some('│' | '┃')) {
        let without_left = trimmed
            .strip_prefix(first.unwrap())
            .unwrap_or(trimmed)
            .strip_suffix(last.unwrap())
            .unwrap_or(trimmed);
        return without_left.trim().to_string();
    }
    trimmed.to_string()
}

fn is_chrome_line(text: &str) -> bool {
    if text.is_empty() {
        return true;
    }
    decoration_line_re().is_match(text)
        || chrome_text_re().is_match(text)
        || completed_status_re().is_match(text)
        || transient_status_re().is_match(text)
        || provider_status_re().is_match(text)
        || token_counter_re().is_match(text)
        || spinner_counter_re().is_match(text)
        || spinner_glyphs_re().is_match(text)
        || internal_status_re().is_match(text)
        || tool_execution_re().is_match(text)
        || prompt_or_header_re().is_match(text)
        || vt100_leftover_re().is_match(text)
        || contains_box_drawing(text)
}

fn remove_inline_status_fragments(text: &str) -> String {
    let without_counter_prefix = inline_counter_prefix_re().replace_all(text, "");
    let without_counter_suffix =
        inline_counter_suffix_re().replace_all(&without_counter_prefix, "");
    let without_token_status = inline_token_status_re().replace_all(&without_counter_suffix, " ");
    let without_elapsed_tail = inline_elapsed_tail_re().replace_all(&without_token_status, "$1");
    without_elapsed_tail.trim().to_string()
}

fn normalize_answer_spacing(text: &str) -> String {
    if !contains_cjk(text) {
        return text.trim().to_string();
    }

    let mut normalized = String::with_capacity(text.len());
    let mut pending_space = false;
    for ch in text.trim().chars() {
        if ch.is_whitespace() {
            pending_space = true;
            continue;
        }
        if pending_space && !normalized.is_empty() {
            normalized.push(' ');
        }
        pending_space = false;
        normalized.push(ch);
    }
    normalized
}

fn contains_cjk(text: &str) -> bool {
    text.chars().any(|ch| {
        matches!(
            ch as u32,
            0x1100..=0x11ff
                | 0x2e80..=0x9fff
                | 0xac00..=0xd7af
                | 0xf900..=0xfaff
                | 0xff00..=0xffef
        )
    })
}

fn contains_box_drawing(text: &str) -> bool {
    text.chars().any(|ch| matches!(ch, '─'..='╿'))
}

fn dedupe_consecutive(lines: Vec<String>) -> Vec<String> {
    let mut result = Vec::new();
    for line in lines {
        if result.last() != Some(&line) {
            result.push(line);
        }
    }
    result
}

fn decoration_line_re() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    VALUE.get_or_init(|| Regex::new(r"^[\s─━│┃╭╮╰╯┌┐└┘╿■-◿▀-▟\-]+$").unwrap())
}

fn chrome_text_re() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    VALUE.get_or_init(|| {
        Regex::new(r#"(?i)(Claude\s*Code|ClaudeCode|Tips?\s*for\s*getting\s*started|Tipsforgettingstarted|Welcome\s*back|Welcomeback|Recent\s*activity|Recentactivity|No\s*recent\s*activity|Norecentactivity|Opus\s*\d|Sonnet\s*\d|Haiku\s*\d|shift\+tab\s*to\s*cycle|bypass\s*permissions|Resume this session|claude\s+--resume|Try\s*["'`]|Tip:|W\s*rked\s+for\s+\d+s|Worke[dp]\s+for\s+\d+s|Processing\.{0,3}|esc\s+to\s+interrupt|ctrl\+\w|auto-?accept\s+edits)"#).unwrap()
    })
}

fn spinner_glyphs_re() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    VALUE.get_or_init(|| Regex::new(r"^[\s*✢✳✽✻✣✶✱✦✧✩✪✫⚡⠀-⣿+.\-→·•◦°]*$").unwrap())
}

fn transient_status_re() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    VALUE.get_or_init(|| {
        Regex::new(r"(?i)^(?:[*✢✳✽✻✣✶✱✦✧✩✪✫⚡+·•◦°]\s*)?(?:Dilly-dallying|Beaming|Brewing|Cogitat(?:ing|ed)|Saut(?:é|ee)ed|Thinking|Processing|Pondering|Metamorphosing|Nesting|Harmonizing|Pontificating|Running\s+\w+|running\s+\w+\s+hooks).*(?:\.\.\.|…|\d+s|\d+\s*tokens?|\))?$").unwrap()
    })
}

fn provider_status_re() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    VALUE.get_or_init(|| {
        Regex::new(r"(?i)^[*✢✳✽✻✣✶✱✦✧✩✪✫⚡+·•◦°]\s*(?:[A-Za-z][A-Za-z -]{1,40}(?:\.\.\.|…).{0,120}|[A-Za-z ]{1,30}ed\s+for\s+\d+s|W\s*rked\s+for\s+\d+s|Worke[dp]\s+for\s+\d+s)$").unwrap()
    })
}

fn completed_status_re() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    VALUE.get_or_init(|| {
        Regex::new(r"(?i)^[*✢✳✽✻✣✶✱✦✧✩✪✫⚡+·•◦°]\s*(?:[A-Za-z ]{1,30}ed\s+for\s+(?:\d+m\s*)?\d+s|W\s*rked\s+for\s+(?:\d+m\s*)?\d+s|Worke[dp]\s+for\s+(?:\d+m\s*)?\d+s|Crun(?:ch(?:ing|ed)|c[a-z:|/]{1,6}(?:ing|d))\s+for/?\s*(?:\d+m\s*)?\d+s)$").unwrap()
    })
}

fn token_counter_re() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    VALUE.get_or_init(|| {
        Regex::new(r"(?i)^(?:\(?\d+s[\s·:./0-9↓↑-]*\d+\s*tokens?\)?|\d+\s*tokens?\)?|running\s+\w+\s+hooks.*tokens?\)?)$").unwrap()
    })
}

fn internal_status_re() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    VALUE.get_or_init(|| {
        Regex::new(r"(?i)(User answered Claude's question|almost done thinking|thought for)")
            .unwrap()
    })
}

fn tool_execution_re() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    VALUE.get_or_init(|| Regex::new(r"(?i)^(?:\$ .+|[└╰]\s*Running\.{3})$").unwrap())
}

fn inline_counter_prefix_re() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    VALUE.get_or_init(|| Regex::new(r"(?i)\(\d+s[\s·:./0-9↓↑-]*").unwrap())
}

fn inline_counter_suffix_re() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    VALUE.get_or_init(|| Regex::new(r"(?i)[A-Za-z]*okens?\)").unwrap())
}

fn inline_token_status_re() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    VALUE.get_or_init(|| Regex::new(r"(?i)\b(?:t?okens?|okens)\s*[·•]\s*thought\s+for\s*").unwrap())
}

fn inline_elapsed_tail_re() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    VALUE.get_or_init(|| Regex::new(r"([.!?。！？])s\)$").unwrap())
}

fn spinner_counter_re() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    VALUE.get_or_init(|| Regex::new(r"^[*✢✳✽✻✣✶✱✦✧✩✪✫⚡+·•◦°]\s*\d{1,3}$").unwrap())
}

fn vt100_leftover_re() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    VALUE.get_or_init(|| Regex::new(r"^[\sqxlkmnvwtujr0-9]{1,12}$").unwrap())
}

fn prompt_or_header_re() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    VALUE.get_or_init(|| {
        Regex::new(r"(?i)^(?:[>❯❱›]\s*.*|\s*[◖◗].*|\s*cwd[:=].*|.*~/(?:workspace|workspaces|src|projects|personal)/.*|[←↵]\s*for\s+\w+)$").unwrap()
    })
}

#[cfg(test)]
mod tests {
    use super::extract_agent_transcript;

    #[test]
    fn filters_claude_frame_to_assistant_content() {
        let lines = vec![
            "╭────ClaudeCodev2.1.97────────────────────────╮".to_string(),
            "│Tipsforgettingstarted│".to_string(),
            "│Welcomebackjune!Run/initto createa CLAUDE.md│".to_string(),
            "│Opus4.6(1Mcontext) C:ClaudeTeam·Wisely│".to_string(),
            "│● 한국어 답변입니다.│".to_string(),
            "╰──────────────────────────────────────────────╯".to_string(),
        ];

        let transcript = extract_agent_transcript(&lines);

        assert_eq!(transcript.assistant_content, "한국어 답변입니다.");
        assert_eq!(transcript.activity, None);
    }

    #[test]
    fn extracts_transient_activity_without_assistant_noise() {
        let lines = vec![
            "● First answer".to_string(),
            "* Dilly-dallying...(2s)".to_string(),
        ];

        let transcript = extract_agent_transcript(&lines);

        assert_eq!(transcript.assistant_content, "First answer");
        assert_eq!(
            transcript.activity.as_deref(),
            Some("* Dilly-dallying...(2s)")
        );
    }

    #[test]
    fn removes_duplicate_redraw_lines() {
        let lines = vec![
            "● Same answer".to_string(),
            "● Same answer".to_string(),
            "● Next answer".to_string(),
        ];

        let transcript = extract_agent_transcript(&lines);

        assert_eq!(transcript.assistant_content, "Same answer\nNext answer");
    }

    #[test]
    fn filters_agent_tui_container_artifacts_from_conversation() {
        let lines = vec![
            "▪ ▪  ~/workspace/personal/agent-memory-graph".to_string(),
            "> echo hello from loom".to_string(),
            "✣ Metamorphosing...".to_string(),
            "─h─llo from".to_string(),
            "loom────────────────────────────────────────────".to_string(),
            "· Metamorphosing... (2s · ↓ 1 tokens)".to_string(),
            "✱ Worked for 2s".to_string(),
            "> 안녕".to_string(),
            "✶ Nesting...".to_string(),
            "└ Tip: Run /install-github-app to tag @claude right from your Github issues and PRs"
                .to_string(),
            "안녕하세요!     무엇을    도와드릴까요?".to_string(),
            "· Nesting... (1s · ↓ 2 tokens)".to_string(),
            "✱ Worked for 2s".to_string(),
        ];

        let transcript = extract_agent_transcript(&lines);

        assert_eq!(
            transcript.assistant_content,
            "안녕하세요! 무엇을 도와드릴까요?"
        );
        assert_eq!(
            transcript.activity.as_deref(),
            Some("· Nesting... (1s · ↓ 2 tokens)")
        );
    }

    #[test]
    fn filters_claude_status_variants_and_inline_counter_bleed() {
        let lines = vec![
            "> echo hello from loom".to_string(),
            "✳ Harmonizing…".to_string(),
            "✽ Harmonizing… (1s · ↓ 1 tokens)".to_string(),
            "✻ Cooked for 2s".to_string(),
            "> 안녕".to_string(),
            "✶ Pontificating…".to_string(),
            "안녕하세요! 무엇을 (1s 도와드릴까요?okens)".to_string(),
            "안녕하세요! 무엇을 도와드릴까요?s)".to_string(),
            "어떤 의미인지 명확하지 않습니다. 다음 중 어떤okens · thought for 것을 원하시나요?"
                .to_string(),
            "✶ Pontificating... (1s · ↓ 2 tokens)".to_string(),
            "✻ W rked for 2s".to_string(),
            ">".to_string(),
        ];

        let transcript = extract_agent_transcript(&lines);

        assert_eq!(
            transcript.assistant_content,
            "안녕하세요! 무엇을 도와드릴까요?"
        );
        assert_eq!(
            transcript.activity.as_deref(),
            Some("✶ Pontificating... (1s · ↓ 2 tokens)")
        );
    }

    #[test]
    fn keeps_prompt_and_hook_status_out_of_assistant_content() {
        let lines = vec![
            "❯ echo hello from loom".to_string(),
            "✢ Brewing...".to_string(),
            "* Brewing... (running stop hooks... 0/4 · 2s · ↓ 2".to_string(),
            "✻ Workep for 2s".to_string(),
            "❯".to_string(),
        ];

        let transcript = extract_agent_transcript(&lines);

        assert_eq!(transcript.assistant_content, "");
        assert_eq!(
            transcript.activity.as_deref(),
            Some("* Brewing... (running stop hooks... 0/4 · 2s · ↓ 2")
        );
    }

    #[test]
    fn filters_corrupted_claude_crunching_elapsed_status() {
        let lines = vec![
            "/Users/june/workspace/personal/agent-memory-graph 입니다.".to_string(),
            "✻ Crunching for 2s".to_string(),
            "✻ Crunching for/2s".to_string(),
            "✻ Cruncp:d for 2s".to_string(),
            "* Cruncp:d for/2s".to_string(),
            "✻ Crunc|ed for/2s".to_string(),
            "● * Crunching for 2s is benchmark copy.".to_string(),
        ];

        let transcript = extract_agent_transcript(&lines);

        assert_eq!(
            transcript.assistant_content,
            "/Users/june/workspace/personal/agent-memory-graph 입니다.\n* Crunching for 2s is benchmark copy."
        );
        assert_eq!(transcript.activity, None);
    }
}
