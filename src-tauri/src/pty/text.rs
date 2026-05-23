pub fn normalize_display_text(input: &str) -> String {
    input
        .chars()
        .filter_map(|ch| {
            if is_private_use(ch) {
                None
            } else if ch == '\u{fffd}' {
                Some('?')
            } else {
                Some(ch)
            }
        })
        .collect()
}

fn is_private_use(ch: char) -> bool {
    matches!(
        ch as u32,
        0xe000..=0xf8ff | 0xf0000..=0xffffd | 0x100000..=0x10fffd
    )
}

#[cfg(test)]
mod tests {
    use super::normalize_display_text;

    #[test]
    fn preserves_korean_and_common_symbols() {
        assert_eq!(normalize_display_text("한글 ✓ →"), "한글 ✓ →");
    }

    #[test]
    fn removes_private_use_missing_glyph_candidates() {
        assert_eq!(normalize_display_text("ok \u{e0b0} 한글"), "ok  한글");
    }

    #[test]
    fn replaces_replacement_character_with_ascii() {
        assert_eq!(normalize_display_text("bad\u{fffd}text"), "bad?text");
    }
}
