//! UTF-16 diagnostic streams, including split byte pairs and surrogate pairs.
pub(super) struct Utf16Decoder {
    big_endian: bool,
    first: bool,
    byte: Option<u8>,
    high: Option<u16>,
}
impl Utf16Decoder {
    pub(super) fn new(big_endian: bool) -> Self {
        Self {
            big_endian,
            first: true,
            byte: None,
            high: None,
        }
    }
    pub(super) fn write(&mut self, bytes: &[u8], output: &mut String) {
        for byte in bytes {
            let Some(first) = self.byte.take() else {
                self.byte = Some(*byte);
                continue;
            };
            let unit = if self.big_endian {
                u16::from_be_bytes([first, *byte])
            } else {
                u16::from_le_bytes([first, *byte])
            };
            let is_first = std::mem::replace(&mut self.first, false);
            if is_first && unit == 0xfeff {
                continue;
            }
            self.unit(unit, output);
        }
    }
    fn unit(&mut self, unit: u16, output: &mut String) {
        if let Some(high) = self.high.take() {
            if (0xdc00..=0xdfff).contains(&unit) {
                let scalar =
                    0x10000 + (u32::from(high) - 0xd800) * 0x400 + u32::from(unit) - 0xdc00;
                output.push(char::from_u32(scalar).unwrap_or(char::REPLACEMENT_CHARACTER));
                return;
            }
            output.push(char::REPLACEMENT_CHARACTER);
        }
        if (0xd800..=0xdbff).contains(&unit) {
            self.high = Some(unit);
        } else {
            output.push(char::from_u32(u32::from(unit)).unwrap_or(char::REPLACEMENT_CHARACTER));
        }
    }
    pub(super) fn end(&mut self, output: &mut String) {
        if self.high.take().is_some() {
            output.push(char::REPLACEMENT_CHARACTER);
        }
        if self.byte.take().is_some() {
            output.push(char::REPLACEMENT_CHARACTER);
        }
    }
}
