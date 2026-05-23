#[derive(Debug, Default)]
pub struct Utf8StreamDecoder {
    pending: Vec<u8>,
}

impl Utf8StreamDecoder {
    pub fn decode(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut decoded = String::new();

        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(valid) => {
                    decoded.push_str(valid);
                    self.pending.clear();
                    break;
                }
                Err(error) => {
                    let valid_up_to = error.valid_up_to();
                    if valid_up_to > 0 {
                        decoded.push_str(
                            std::str::from_utf8(&self.pending[..valid_up_to])
                                .expect("valid_up_to is guaranteed to be valid UTF-8"),
                        );
                    }

                    match error.error_len() {
                        Some(invalid_len) => {
                            decoded.push('\u{fffd}');
                            self.pending.drain(..valid_up_to + invalid_len);
                        }
                        None => {
                            self.pending.drain(..valid_up_to);
                            break;
                        }
                    }
                }
            }
        }

        decoded
    }

    pub fn finish(&mut self) -> String {
        if self.pending.is_empty() {
            return String::new();
        }

        let decoded = String::from_utf8_lossy(&self.pending).to_string();
        self.pending.clear();
        decoded
    }
}

#[cfg(test)]
mod tests {
    use super::Utf8StreamDecoder;

    #[test]
    fn preserves_hangul_split_across_chunks() {
        let mut decoder = Utf8StreamDecoder::default();
        let bytes = "한글 출력".as_bytes();
        let mut decoded = String::new();

        for byte in bytes {
            decoded.push_str(&decoder.decode(&[*byte]));
        }
        decoded.push_str(&decoder.finish());

        assert_eq!(decoded, "한글 출력");
    }

    #[test]
    fn replaces_invalid_bytes_without_losing_later_hangul() {
        let mut decoder = Utf8StreamDecoder::default();
        let mut decoded = decoder.decode(&[0xff]);
        decoded.push_str(&decoder.decode("정상".as_bytes()));
        decoded.push_str(&decoder.finish());

        assert_eq!(decoded, "\u{fffd}정상");
    }
}
