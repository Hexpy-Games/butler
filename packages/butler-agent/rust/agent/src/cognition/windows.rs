mod spans;
mod types;

pub(crate) use spans::{grapheme_byte_boundaries, split_historical_source_spans};
pub(crate) use types::ByteSpan;

pub(crate) const MEMORY_SOURCE_WINDOW_BYTES: f64 = 8_192.0;
#[cfg(test)]
mod tests;
