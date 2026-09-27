//! Shared pure Unicode normalization and source-compatible gram construction.

mod unicode;

pub(in crate::cognition) use unicode::{case_fold, terms};

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_full_case_fold_and_ordered_grapheme_terms() {
        assert_eq!(case_fold("Straße İΣς"), "strasse i̇σσ");
        assert_eq!(
            terms("a🙂b").into_iter().collect::<Vec<_>>(),
            ["a", "🙂", "b", "a🙂", "🙂b", "a🙂b"]
        );
    }
}
