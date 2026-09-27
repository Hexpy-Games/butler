//! Opaque v2 source handles and contiguous original-text raw excerpts.

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};

use crate::cognition::lexical;
use crate::segmentation::grapheme_segments;

pub(super) fn handle(generation: &str, source_id: &str) -> String {
    format!(
        "memory-source:v2:{}:{}",
        URL_SAFE_NO_PAD.encode(generation),
        URL_SAFE_NO_PAD.encode(source_id)
    )
}

pub(super) fn raw_source_id(handle: &str) -> Option<String> {
    let mut parts = handle.split(':');
    if parts.next() != Some("memory-source") || parts.next() != Some("v2") {
        return None;
    }
    let _generation = parts.next()?;
    let source = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    String::from_utf8(URL_SAFE_NO_PAD.decode(source).ok()?).ok()
}

pub(super) fn raw_excerpt(text: &str, phrases: &[String], limit: usize) -> String {
    let segments = grapheme_segments(text).collect::<Vec<_>>();
    if segments.len() <= limit {
        return text.into();
    }
    let mut offsets = Vec::with_capacity(segments.len());
    let mut folded = String::new();
    let mut folded_units = 0usize;
    for segment in &segments {
        offsets.push(folded_units);
        let key = lexical::case_fold(segment.text);
        folded_units += key.encode_utf16().count();
        folded.push_str(&key);
    }
    let mut keys = phrases
        .iter()
        .map(|phrase| lexical::case_fold(crate::public_text::trim_js_whitespace(phrase)))
        .chain(source_query_terms(phrases))
        .filter(|key| !key.is_empty())
        .collect::<Vec<_>>();
    keys.sort_by_key(|key| std::cmp::Reverse(key.encode_utf16().count()));
    let match_at = keys.into_iter().find_map(|key| {
        folded
            .find(&key)
            .map(|offset| folded[..offset].encode_utf16().count())
    });
    let match_index = match_at.map_or(0, |offset| {
        offsets
            .partition_point(|start| *start <= offset)
            .saturating_sub(1)
    });
    let start = match_index
        .saturating_sub(limit / 4)
        .min(segments.len() - limit);
    let end = start + limit;
    text[segments[start].start
        ..segments
            .get(end)
            .map_or(text.len(), |segment| segment.start)]
        .into()
}

fn source_query_terms(phrases: &[String]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut terms = Vec::new();
    for phrase in phrases {
        let folded = lexical::case_fold(crate::public_text::trim_js_whitespace(phrase));
        let grams = lexical::folded_grams(&folded);
        let candidates = if grams.is_empty() {
            vec![folded]
        } else {
            grams
        };
        for candidate in candidates {
            if !crate::public_text::trim_js_whitespace(&candidate).is_empty()
                && seen.insert(candidate.clone())
            {
                terms.push(candidate);
            }
        }
    }
    terms
}
