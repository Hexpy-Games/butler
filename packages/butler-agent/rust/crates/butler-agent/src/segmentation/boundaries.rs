use unicode_segmentation::UnicodeSegmentation;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct TextSegment<'a> {
    pub(crate) text: &'a str,
    pub(crate) start: usize,
    pub(crate) end: usize,
}

pub(crate) fn grapheme_segments(text: &str) -> impl DoubleEndedIterator<Item = TextSegment<'_>> {
    text.grapheme_indices(true)
        .map(|(start, text)| TextSegment {
            text,
            start,
            end: start + text.len(),
        })
}

pub(crate) fn sentence_segments(text: &str) -> impl Iterator<Item = TextSegment<'_>> {
    text.split_sentence_bound_indices()
        .map(|(start, text)| TextSegment {
            text,
            start,
            end: start + text.len(),
        })
}
