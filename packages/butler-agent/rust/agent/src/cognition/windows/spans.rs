use crate::segmentation::grapheme_segments;

use super::ByteSpan;
#[cfg(test)]
use super::{ByteMidpoint, MEMORY_SPLIT_MIN_SOURCE_BYTES, WindowPart};

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

#[cfg(test)]
pub(crate) fn nearest_grapheme_byte_midpoint(parts: &[WindowPart<'_>]) -> Option<ByteMidpoint> {
    let total = parts.iter().map(|part| part.bytes).sum::<f64>();
    if total < MEMORY_SPLIT_MIN_SOURCE_BYTES * 2.0 {
        return None;
    }
    let mut cumulative = 0.0;
    let mut best = None;
    let mut best_distance = f64::INFINITY;
    for (part_index, part) in parts.iter().enumerate() {
        for local_byte in grapheme_segments(part.text).map(|segment| segment.end) {
            let left = cumulative + local_byte as f64;
            let right = total - left;
            if left < MEMORY_SPLIT_MIN_SOURCE_BYTES || right < MEMORY_SPLIT_MIN_SOURCE_BYTES {
                continue;
            }
            if local_byte as f64 == part.bytes && part_index == parts.len() - 1 {
                continue;
            }
            let distance = (left - total / 2.0).abs();
            if distance < best_distance {
                best = Some(ByteMidpoint {
                    part_index,
                    local_byte,
                });
                best_distance = distance;
            }
        }
        cumulative += part.bytes;
    }
    best
}
