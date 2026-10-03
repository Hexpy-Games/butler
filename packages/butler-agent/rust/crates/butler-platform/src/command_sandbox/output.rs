//! Streaming command output decoding. Normal Windows shell output is UTF-8;
//! PowerShell startup failures can emit BOM-less UTF-16 before setup runs.
mod utf8;
#[cfg(windows)]
mod windows;
#[cfg(not(windows))]
use utf8::Utf8Decoder as Decoder;
#[cfg(windows)]
use windows::Decoder;

/// Incremental decoder retaining only an incomplete character / sniff prefix.
#[derive(Default)]
pub struct CommandOutputDecoder(Decoder);
impl CommandOutputDecoder {
    /// Appends decoded text, retaining incomplete character bytes.
    pub fn write(&mut self, bytes: &[u8], output: &mut String) {
        self.0.write(bytes, output);
    }
    /// Flushes a stream, replacing an incomplete final character.
    pub fn end(&mut self, output: &mut String) {
        self.0.end(output);
    }
}
