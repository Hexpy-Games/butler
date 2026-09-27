use unicode_segmentation::UnicodeSegmentation;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TextSegment<'a> {
    pub text: &'a str,
    pub start: usize,
    pub end: usize,
}

pub fn grapheme_segments(text: &str) -> impl DoubleEndedIterator<Item = TextSegment<'_>> {
    text.grapheme_indices(true)
        .map(|(start, text)| TextSegment {
            text,
            start,
            end: start + text.len(),
        })
}

pub fn sentence_segments(text: &str) -> impl Iterator<Item = TextSegment<'_>> {
    text.split_sentence_bound_indices()
        .map(|(start, text)| TextSegment {
            text,
            start,
            end: start + text.len(),
        })
}
