//! Shared pure Unicode normalization and source-compatible gram construction.

pub(in crate::cognition) use butler_core::search_text::case_fold;

use indexmap::IndexSet;
use std::collections::HashSet;
use unicode_segmentation::UnicodeSegmentation;

pub(in crate::cognition) fn folded_grams(value: &str) -> Vec<String> {
    let folded = case_fold(value);
    let letters = UnicodeSegmentation::graphemes(folded.as_str(), true).collect::<Vec<_>>();
    let mut seen = HashSet::new();
    let mut grams = Vec::new();
    for size in [2, 3] {
        for span in letters.windows(size) {
            let gram = span.concat();
            if seen.insert(gram.clone()) {
                grams.push(gram);
            }
        }
    }
    grams
}

pub(in crate::cognition) fn terms(value: &str) -> IndexSet<String> {
    let graphemes = UnicodeSegmentation::graphemes(value, true).collect::<Vec<_>>();
    let mut terms = IndexSet::new();
    terms.extend(graphemes.iter().map(|value| (*value).to_owned()));
    for size in [2, 3] {
        for items in graphemes.windows(size) {
            terms.insert(items.concat());
        }
    }
    terms
}
