pub fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch != '\u{1b}' {
            out.push(ch);
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
                    if next == '\u{7}' || (previous_was_escape && next == '\\') {
                        break;
                    }
                    previous_was_escape = next == '\u{1b}';
                }
            }
            Some(_) => {
                chars.next();
            }
            None => {}
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::strip_ansi;

    #[test]
    fn removes_sgr_sequences() {
        assert_eq!(strip_ansi("\u{1b}[31mred\u{1b}[0m"), "red");
    }

    #[test]
    fn removes_osc_sequences() {
        assert_eq!(strip_ansi("\u{1b}]0;title\u{7}body"), "body");
    }
}
