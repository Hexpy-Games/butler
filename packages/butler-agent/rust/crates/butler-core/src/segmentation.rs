//! Borrowed Unicode 17 text boundaries shared by native domains.

mod boundaries;
mod spans;

pub use boundaries::{grapheme_segments, sentence_segments};
pub use spans::split_grapheme_utf8_spans;
