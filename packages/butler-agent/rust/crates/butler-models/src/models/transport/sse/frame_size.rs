//! Incremental byte length of the same lossy UTF-8 used by the frame decoder.
#[derive(Default)]
pub(super) struct FrameSize {
    checked: usize,
    bytes: usize,
}

impl FrameSize {
    pub(super) fn decoded_bytes(&mut self, frame: &[u8]) -> usize {
        // A just-completed delimiter can include bytes counted in the tail
        // on the previous chunk. Recompute this completed frame once.
        if self.checked > frame.len() {
            *self = Self::default();
        }
        while self.checked < frame.len() {
            match std::str::from_utf8(&frame[self.checked..]) {
                Ok(text) => {
                    self.bytes += text.len();
                    self.checked = frame.len();
                }
                Err(error) => {
                    self.checked += error.valid_up_to();
                    self.bytes += error.valid_up_to();
                    if let Some(invalid) = error.error_len() {
                        self.checked += invalid;
                        self.bytes += 3; // UTF-8 replacement character.
                    } else {
                        // Retain the incomplete sequence for the next chunk;
                        // the current lossy view replaces it with one U+FFFD.
                        return self.bytes + 3;
                    }
                }
            }
        }
        self.bytes
    }
}

#[cfg(test)]
pub(in crate::models) fn verify() {
    for source in [
        &b"ascii\r\n"[..],
        "한글🧑\r\n".as_bytes(),
        &[0xf0, 0x9f, 0x92, 0xa9, 0xff, 0xe0, 0xa0, b'X', 0xc2],
    ] {
        let mut size = FrameSize::default();
        for end in 0..=source.len() {
            assert_eq!(
                size.decoded_bytes(&source[..end]),
                String::from_utf8_lossy(&source[..end]).len()
            );
        }
        assert_eq!(
            size.decoded_bytes(&source[..1]),
            String::from_utf8_lossy(&source[..1]).len()
        );
    }
}
