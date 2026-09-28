//! Splitting source text into extraction windows.

mod spans;

pub(crate) use spans::{grapheme_byte_boundaries, split_historical_source_spans};

pub(crate) const MEMORY_SOURCE_WINDOW_BYTES: f64 = 8_192.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ByteSpan {
    pub(crate) start: usize,
    pub(crate) end: usize,
}

#[cfg(test)]
mod tests;
