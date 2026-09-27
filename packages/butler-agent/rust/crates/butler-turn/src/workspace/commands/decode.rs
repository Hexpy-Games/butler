#[derive(Default)]
pub(super) struct Utf8Decoder {
    pending: Vec<u8>,
}

impl Utf8Decoder {
    pub(super) fn write(&mut self, bytes: &[u8], output: &mut String) {
        self.pending.extend_from_slice(bytes);
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(valid) => {
                    output.push_str(valid);
                    self.pending.clear();
                    return;
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    output.push_str(
                        // `valid_up_to` bytes decode by definition.
                        std::str::from_utf8(&self.pending[..valid]).unwrap_or_default(),
                    );
                    let bad = error.error_len();
                    self.pending.drain(..valid);
                    if let Some(length) = bad {
                        output.push('\u{fffd}');
                        self.pending.drain(..length);
                    } else {
                        return;
                    }
                }
            }
        }
    }

    pub(super) fn end(&mut self, output: &mut String) {
        if !self.pending.is_empty() {
            output.push('\u{fffd}');
            self.pending.clear();
        }
    }
}
