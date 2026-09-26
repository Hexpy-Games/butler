use crate::segmentation::{grapheme_segments, sentence_segments};

use super::ByteSpan;

const MAX_MEANING_BYTES: f64 = 3_500.0;
const MAX_MEANING_GRAPHEMES: usize = 512;

pub(crate) fn split_meaning_source_spans(text: &str, max_bytes: f64) -> Vec<ByteSpan> {
    let limit = if max_bytes.is_nan() {
        f64::NAN
    } else {
        max_bytes.min(MAX_MEANING_BYTES)
    };
    let mut output = Vec::new();
    let mut start = 0;
    let mut end = 0;
    let mut count = 0;
    for sentence in sentence_segments(text) {
        let clusters = grapheme_segments(sentence.text).collect::<Vec<_>>();
        if count > 0
            && (count + clusters.len() > MAX_MEANING_GRAPHEMES
                || (end - start + sentence.text.len()) as f64 > limit)
        {
            flush(&mut output, &mut start, end, &mut count);
        }
        for cluster in clusters {
            let bytes = cluster.text.len();
            if count > 0 && (count == MAX_MEANING_GRAPHEMES || (end - start + bytes) as f64 > limit)
            {
                flush(&mut output, &mut start, end, &mut count);
            }
            end += bytes;
            count += 1;
        }
    }
    flush(&mut output, &mut start, end, &mut count);
    output
}

fn flush(output: &mut Vec<ByteSpan>, start: &mut usize, end: usize, count: &mut usize) {
    if end > *start {
        output.push(ByteSpan { start: *start, end });
    }
    *start = end;
    *count = 0;
}
