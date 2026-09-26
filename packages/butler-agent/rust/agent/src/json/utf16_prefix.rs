//! A JavaScript prefix of valid UTF-8 can end with an unpaired high surrogate.
//! Retain that boundary explicitly, without copying the complete input to UTF-16.

use std::borrow::Cow;

use super::JsonError;

pub(crate) struct Utf16Prefix<'a> {
    text: Cow<'a, str>,
    trailing_high: Option<u16>,
}

impl<'a> Utf16Prefix<'a> {
    pub(crate) fn new(text: impl Into<Cow<'a, str>>, max_units: usize) -> Self {
        Self {
            text: text.into(),
            trailing_high: None,
        }
        .prefix(max_units)
    }

    pub(crate) fn len_utf16(&self) -> usize {
        self.text.encode_utf16().count() + usize::from(self.trailing_high.is_some())
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.text.is_empty() && self.trailing_high.is_none()
    }

    pub(crate) fn prefix(mut self, max_units: usize) -> Self {
        let mut units = 0;
        for (index, character) in self.text.char_indices() {
            if units + character.len_utf16() > max_units {
                self.trailing_high = if units < max_units {
                    Some(character.encode_utf16(&mut [0; 2])[0])
                } else {
                    None
                };
                match &mut self.text {
                    Cow::Borrowed(text) => *text = &text[..index],
                    Cow::Owned(text) => text.truncate(index),
                }
                return self;
            }
            units += character.len_utf16();
        }
        if units == max_units {
            self.trailing_high = None;
        }
        self
    }

    /// Equivalent to replace(/\s+/gu, " ").trim(), using the caller's exact
    /// ECMAScript whitespace predicate. A final surrogate is non-whitespace.
    pub(crate) fn collapse_whitespace(
        &self,
        mut is_whitespace: impl FnMut(char) -> bool,
    ) -> Utf16Prefix<'static> {
        let mut text = String::new();
        let mut pending_space = false;
        for character in self.text.chars() {
            if is_whitespace(character) {
                pending_space = !text.is_empty();
            } else {
                if pending_space {
                    text.push(' ');
                }
                text.push(character);
                pending_space = false;
            }
        }
        if pending_space && self.trailing_high.is_some() {
            text.push(' ');
        }
        Utf16Prefix {
            text: Cow::Owned(text),
            trailing_high: self.trailing_high,
        }
    }

    /// Node's UTF-8 hash input replaces an unpaired surrogate with U+FFFD.
    pub(crate) fn utf8_for_hash(&self) -> Cow<'_, str> {
        if self.trailing_high.is_some() {
            let mut text = self.text.to_string();
            text.push('\u{fffd}');
            Cow::Owned(text)
        } else {
            Cow::Borrowed(&self.text)
        }
    }

    /// JSON.stringify preserves an unpaired surrogate as a Unicode escape.
    pub(crate) fn json_literal(&self) -> Result<String, JsonError> {
        let mut output = String::new();
        super::write_string(&self.text, &mut output)?;
        if let Some(high) = self.trailing_high {
            use std::fmt::Write;
            output.pop();
            // Writing to a String cannot fail.
            let _ = write!(output, "\\u{high:04x}\"");
        }
        Ok(output)
    }
}

#[cfg(test)]
mod tests;
