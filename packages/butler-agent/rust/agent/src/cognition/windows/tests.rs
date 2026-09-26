use super::*;
use crate::segmentation::split_grapheme_utf8_spans;

#[test]
fn historical_windows_split_on_grapheme_boundaries_in_source_order() {
    assert_eq!(
        split_grapheme_utf8_spans("abcdef", 4.0)
            .into_iter()
            .map(|span| (span.start, span.end, span.oversized))
            .collect::<Vec<_>>(),
        vec![(0, 4, false), (4, 6, false)]
    );
    assert_eq!(
        split_historical_source_spans("abcdef", 4.0),
        vec![
            ByteSpan { start: 0, end: 4 },
            ByteSpan { start: 4, end: 5 },
            ByteSpan { start: 5, end: 6 },
        ]
    );
    assert_eq!(grapheme_byte_boundaries(""), vec![0]);
}
