use super::utf8::Utf8Decoder;
mod utf16;
use utf16::Utf16Decoder;

#[derive(Default)]
pub(super) struct Decoder {
    prefix: Vec<u8>,
    mode: Option<Mode>,
}
enum Mode {
    Utf8(Utf8Decoder),
    Utf16(Utf16Decoder),
}
impl Decoder {
    pub(super) fn write(&mut self, bytes: &[u8], output: &mut String) {
        if self.mode.is_none() {
            self.prefix.extend_from_slice(bytes);
            if self.prefix.len() < 64 {
                return;
            }
            self.select();
            let prefix = std::mem::take(&mut self.prefix);
            self.decode(&prefix, output, false);
        } else {
            self.decode(bytes, output, false);
        }
    }
    pub(super) fn end(&mut self, output: &mut String) {
        if self.mode.is_none() {
            self.select();
            let prefix = std::mem::take(&mut self.prefix);
            self.decode(&prefix, output, false);
        }
        self.decode(&[], output, true);
    }
    fn select(&mut self) {
        let sample = self.prefix.get(..64).unwrap_or(&self.prefix);
        let pairs = || sample.chunks_exact(2);
        let le = self.prefix.starts_with(&[0xff, 0xfe])
            || pairs().filter(|p| p.get(1) == Some(&0)).count() >= 3;
        let be = self.prefix.starts_with(&[0xfe, 0xff])
            || pairs().filter(|p| p.first() == Some(&0)).count() >= 3;
        self.mode = Some(if le {
            Mode::Utf16(Utf16Decoder::new(false))
        } else if be {
            Mode::Utf16(Utf16Decoder::new(true))
        } else {
            Mode::Utf8(Utf8Decoder::default())
        });
    }
    fn decode(&mut self, bytes: &[u8], output: &mut String, last: bool) {
        match &mut self.mode {
            Some(Mode::Utf8(decoder)) => {
                decoder.write(bytes, output);
                if last {
                    decoder.end(output);
                }
            }
            Some(Mode::Utf16(decoder)) => {
                decoder.write(bytes, output);
                if last {
                    decoder.end(output);
                }
            }
            None => {}
        }
    }
}
