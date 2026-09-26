#[cfg(test)]
mod meaning;
mod spans;
mod types;

#[cfg(test)]
pub(crate) use meaning::split_meaning_source_spans;
#[cfg(test)]
pub(crate) use spans::nearest_grapheme_byte_midpoint;
pub(crate) use spans::{grapheme_byte_boundaries, split_historical_source_spans};
pub(crate) use types::ByteSpan;
#[cfg(test)]
pub(crate) use types::{ByteMidpoint, WindowPart};

pub(crate) const MEMORY_SOURCE_WINDOW_BYTES: f64 = 8_192.0;
#[cfg(test)]
pub(crate) const MEMORY_SPLIT_MIN_SOURCE_BYTES: f64 = 512.0;
#[cfg(test)]
mod tests;
