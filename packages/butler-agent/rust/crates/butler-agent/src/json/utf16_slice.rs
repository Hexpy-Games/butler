//! Borrowed UTF-16 ranges over valid UTF-8, retaining split surrogate boundaries.

use std::borrow::Cow;

#[derive(Clone, Copy, Debug)]
pub(crate) struct Utf16Slice<'a> {
    body: &'a str,
    leading_low: Option<u16>,
    trailing_high: Option<u16>,
    units: usize,
}

impl<'a> Utf16Slice<'a> {
    /// Nonnegative, exclusive UTF-16 range, clamped to the source length.
    /// Callers normalize negative/nonfinite JavaScript arguments before this API.
    pub(crate) fn new(text: &'a str, start: usize, end: usize) -> Self {
        let mut output = Self {
            body: &text[..0],
            leading_low: None,
            trailing_high: None,
            units: 0,
        };
        if end <= start {
            return output;
        }
        let mut offset = 0;
        let mut body_start = None;
        let mut body_end = 0;
        for (byte, character) in text.char_indices() {
            if offset >= end {
                break;
            }
            let next = offset + character.len_utf16();
            let left = start.max(offset);
            let right = end.min(next);
            if left < right {
                output.units += right - left;
                if left == offset && right == next {
                    body_start.get_or_insert(byte);
                    body_end = byte + character.len_utf8();
                } else {
                    let mut pair = [0; 2];
                    character.encode_utf16(&mut pair);
                    if left > offset {
                        output.leading_low = Some(pair[1]);
                    } else {
                        output.trailing_high = Some(pair[0]);
                    }
                }
            }
            offset = next;
        }
        if let Some(start) = body_start {
            output.body = &text[start..body_end];
        }
        output
    }

    pub(crate) fn len_utf16(&self) -> usize {
        self.units
    }

    pub(crate) fn code_units(&self) -> impl Iterator<Item = u16> + '_ {
        self.leading_low
            .into_iter()
            .chain(self.body.encode_utf16())
            .chain(self.trailing_high)
    }

    /// The UTF-8 boundary used by Node Buffer/TextEncoder, not the JSON boundary.
    pub(crate) fn utf8_lossy(&self) -> Cow<'a, str> {
        if self.leading_low.is_none() && self.trailing_high.is_none() {
            return Cow::Borrowed(self.body);
        }
        let mut output = String::with_capacity(self.body.len() + 6);
        if self.leading_low.is_some() {
            output.push('\u{fffd}');
        }
        output.push_str(self.body);
        if self.trailing_high.is_some() {
            output.push('\u{fffd}');
        }
        Cow::Owned(output)
    }
}

#[cfg(test)]
mod tests;
