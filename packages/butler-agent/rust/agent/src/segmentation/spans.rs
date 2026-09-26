use super::grapheme_segments;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct GraphemeByteSpan {
    pub(crate) start: usize,
    pub(crate) end: usize,
    pub(crate) oversized: bool,
}

pub(crate) fn split_grapheme_utf8_spans(text: &str, max_bytes: f64) -> Vec<GraphemeByteSpan> {
    let mut spans = Vec::new();
    let mut start = 0;
    let mut prior = 0;
    for end in grapheme_segments(text).map(|segment| segment.end) {
        if (end - start) as f64 > max_bytes {
            if prior > start {
                spans.push(GraphemeByteSpan {
                    start,
                    end: prior,
                    oversized: false,
                });
            }
            start = prior;
            if (end - prior) as f64 > max_bytes {
                spans.push(GraphemeByteSpan {
                    start: prior,
                    end,
                    oversized: true,
                });
                start = end;
            }
        }
        prior = end;
    }
    if text.len() > start {
        spans.push(GraphemeByteSpan {
            start,
            end: text.len(),
            oversized: false,
        });
    }
    spans
}
