const DEFAULT_COLS: u16 = 220;
const DEFAULT_ROWS: u16 = 60;
const DEFAULT_SCROLLBACK: usize = 400;
const TAB_WIDTH: usize = 8;
const ESC: char = '\u{1b}';

type ScreenLine = Vec<char>;

#[derive(Debug, Clone)]
pub struct RendererSnapshot {
    pub lines: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct HeadlessAgentRenderer {
    screen: Vec<ScreenLine>,
    cols: usize,
    rows: usize,
    scrollback: usize,
    cursor_row: usize,
    cursor_col: usize,
    pending_escape: String,
}

impl HeadlessAgentRenderer {
    pub fn new(cols: u16, rows: u16) -> Self {
        Self {
            screen: vec![Vec::new()],
            cols: usize::from(if cols == 0 { DEFAULT_COLS } else { cols }),
            rows: usize::from(if rows == 0 { DEFAULT_ROWS } else { rows }),
            scrollback: DEFAULT_SCROLLBACK,
            cursor_row: 0,
            cursor_col: 0,
            pending_escape: String::new(),
        }
    }

    pub fn write_str(&mut self, chunk: &str) {
        for ch in chunk.chars() {
            self.write_char(ch);
        }
    }

    pub fn snapshot(&self) -> RendererSnapshot {
        let mut lines: Vec<String> = self
            .screen
            .iter()
            .map(|line| line.iter().collect::<String>().trim_end().to_string())
            .collect();
        while lines.last().is_some_and(|line| line.is_empty()) {
            lines.pop();
        }
        RendererSnapshot { lines }
    }

    fn write_char(&mut self, ch: char) {
        if !self.pending_escape.is_empty() {
            self.pending_escape.push(ch);
            self.consume_pending_escape();
            return;
        }

        match ch {
            ESC => self.pending_escape.push(ESC),
            '\r' => self.cursor_col = 0,
            '\n' => self.new_line(),
            '\u{8}' => self.cursor_col = self.cursor_col.saturating_sub(1),
            '\t' => self.write_tab(),
            _ if ch.is_control() => {}
            _ => self.write_printable(ch),
        }
    }

    fn consume_pending_escape(&mut self) {
        if !self.is_pending_escape_complete() {
            if self.pending_escape.len() > 256 {
                self.pending_escape.clear();
            }
            return;
        }

        let sequence = std::mem::take(&mut self.pending_escape);
        if sequence.starts_with("\u{1b}[") {
            self.apply_csi(&sequence);
        }
    }

    fn is_pending_escape_complete(&self) -> bool {
        let mut chars = self.pending_escape.chars();
        if chars.next() != Some(ESC) {
            return true;
        }
        let Some(second) = chars.next() else {
            return false;
        };

        match second {
            '[' => self
                .pending_escape
                .chars()
                .skip(2)
                .any(|ch| ('@'..='~').contains(&ch)),
            ']' => {
                self.pending_escape.ends_with('\u{7}') || self.pending_escape.ends_with("\u{1b}\\")
            }
            '(' | ')' | '*' | '+' => self.pending_escape.chars().count() >= 3,
            _ => true,
        }
    }

    fn apply_csi(&mut self, sequence: &str) {
        let Some(final_char) = sequence.chars().last() else {
            return;
        };
        let body = sequence
            .strip_prefix("\u{1b}[")
            .and_then(|value| value.strip_suffix(final_char))
            .unwrap_or_default()
            .trim_start_matches(|ch: char| matches!(ch, '?' | ';' | '>' | '<' | '='));
        let values: Vec<Option<usize>> = body
            .split(';')
            .map(|value| value.parse::<usize>().ok())
            .collect();
        let param = |index: usize, fallback: usize| -> usize {
            values
                .get(index)
                .and_then(|value| *value)
                .unwrap_or(fallback)
        };

        match final_char {
            'A' => self.move_cursor(self.cursor_row.saturating_sub(param(0, 1)), self.cursor_col),
            'B' => self.move_cursor(self.cursor_row.saturating_add(param(0, 1)), self.cursor_col),
            'C' => self.move_cursor(self.cursor_row, self.cursor_col.saturating_add(param(0, 1))),
            'D' => self.move_cursor(self.cursor_row, self.cursor_col.saturating_sub(param(0, 1))),
            'G' => self.move_cursor(self.cursor_row, param(0, 1).saturating_sub(1)),
            'H' | 'f' => {
                self.move_cursor(param(0, 1).saturating_sub(1), param(1, 1).saturating_sub(1))
            }
            'K' => self.erase_line(param(0, 0)),
            'J' => self.erase_display(param(0, 0)),
            _ => {}
        }
    }

    fn write_tab(&mut self) {
        let next_stop = (self.cursor_col / TAB_WIDTH + 1) * TAB_WIDTH;
        for _ in self.cursor_col..next_stop {
            self.write_printable(' ');
        }
    }

    fn write_printable(&mut self, ch: char) {
        if self.cursor_col >= self.cols {
            self.new_line();
        }
        let cursor_col = self.cursor_col;
        let line = self.current_line();
        while line.len() < cursor_col {
            line.push(' ');
        }
        if line.len() == cursor_col {
            line.push(ch);
        } else {
            line[cursor_col] = ch;
        }
        self.cursor_col += 1;
        if self.cursor_col >= self.cols {
            self.new_line();
        }
    }

    fn new_line(&mut self) {
        self.cursor_row += 1;
        self.cursor_col = 0;
        self.ensure_cursor_line();
    }

    fn move_cursor(&mut self, row: usize, col: usize) {
        self.cursor_row = row;
        self.cursor_col = col.min(self.cols.saturating_sub(1));
        self.ensure_cursor_line();
    }

    fn current_line(&mut self) -> &mut ScreenLine {
        self.ensure_cursor_line();
        &mut self.screen[self.cursor_row]
    }

    fn ensure_cursor_line(&mut self) {
        while self.screen.len() <= self.cursor_row {
            self.screen.push(Vec::new());
        }
        self.trim_to_bounds();
    }

    fn trim_to_bounds(&mut self) {
        let max_line_count = self.rows + self.scrollback;
        if self.screen.len() <= max_line_count {
            return;
        }
        let excess = self.screen.len() - max_line_count;
        self.screen.drain(..excess);
        self.cursor_row = self.cursor_row.saturating_sub(excess);
    }

    fn erase_line(&mut self, mode: usize) {
        let cursor_col = self.cursor_col;
        let line = self.current_line();
        match mode {
            2 => {
                line.clear();
                self.cursor_col = 0;
            }
            1 => {
                let end = cursor_col.min(line.len().saturating_sub(1));
                for index in 0..=end {
                    if index < line.len() {
                        line[index] = ' ';
                    }
                }
                trim_line_end(line);
            }
            _ => line.truncate(cursor_col.min(line.len())),
        }
    }

    fn erase_display(&mut self, mode: usize) {
        match mode {
            2 | 3 => {
                self.screen = vec![Vec::new()];
                self.cursor_row = 0;
                self.cursor_col = 0;
            }
            1 => {
                for index in 0..self.cursor_row.min(self.screen.len()) {
                    self.screen[index].clear();
                }
                self.erase_line(1);
            }
            _ => {
                self.erase_line(0);
                for index in (self.cursor_row + 1)..self.screen.len() {
                    self.screen[index].clear();
                }
            }
        }
    }
}

fn trim_line_end(line: &mut ScreenLine) {
    while line.last() == Some(&' ') {
        line.pop();
    }
}

#[cfg(test)]
mod tests {
    use super::HeadlessAgentRenderer;

    #[test]
    fn carriage_return_overwrites_status_line() {
        let mut renderer = HeadlessAgentRenderer::new(80, 10);
        renderer.write_str("* Dilly...\r* Dilly...(2s)\r● final answer");

        assert_eq!(renderer.snapshot().lines, vec!["● final answer"]);
    }

    #[test]
    fn ansi_cursor_up_and_erase_replaces_previous_line() {
        let mut renderer = HeadlessAgentRenderer::new(80, 10);
        renderer.write_str("old status\nanswer");
        renderer.write_str("\u{1b}[1A\u{1b}[2Knew status\n");

        assert_eq!(renderer.snapshot().lines, vec!["new status", "answer"]);
    }

    #[test]
    fn preserves_utf8_across_writes() {
        let mut renderer = HeadlessAgentRenderer::new(80, 10);
        renderer.write_str("한");
        renderer.write_str("글 답변");

        assert_eq!(renderer.snapshot().lines, vec!["한글 답변"]);
    }
}
