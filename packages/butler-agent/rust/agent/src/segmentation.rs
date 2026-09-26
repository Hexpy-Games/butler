//! Borrowed Unicode 17 text boundaries shared by native domains.

mod boundaries;
mod spans;

pub(crate) use boundaries::{grapheme_segments, sentence_segments};
pub(crate) use spans::split_grapheme_utf8_spans;

#[cfg(test)]
mod tests;
