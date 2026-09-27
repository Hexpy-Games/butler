use crate::segmentation::grapheme_segments;

use super::ByteSpan;

pub(crate) fn grapheme_byte_boundaries(text: &str) -> Vec<usize> {
    let mut output = Vec::new();
    output.push(0);
    output.extend(grapheme_segments(text).map(|segment| segment.end));
    output
}

pub(crate) fn split_historical_source_spans(text: &str, max_bytes: f64) -> Vec<ByteSpan> {
    let boundaries = grapheme_byte_boundaries(text);
    let mut spans = Vec::new();
    let mut start = 0;
    for index in 1..boundaries.len() {
        let end = boundaries[index];
        if (end - start) as f64 > max_bytes {
            let prior = boundaries[index - 1];
            if prior > start {
                spans.push(ByteSpan { start, end: prior });
            }
            spans.push(ByteSpan { start: prior, end });
            start = end;
        }
    }
    let end = boundaries.last().copied().unwrap_or(0);
    if end > start {
        spans.push(ByteSpan { start, end });
    }
    spans
}
