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
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Golden {
        input: String,
        folded: String,
        terms: Vec<String>,
    }

    #[test]
    fn exact_full_case_fold_and_ordered_grapheme_terms() {
        assert_eq!(case_fold("Straße İΣς"), "strasse i̇σσ");
        assert_eq!(
            terms("a🙂b").into_iter().collect::<Vec<_>>(),
            ["a", "🙂", "b", "a🙂", "🙂b", "a🙂b"]
        );
    }

    #[test]
    fn actual_bun_source_index_goldens_match() {
        let fixtures: Vec<Golden> =
            serde_json::from_str(include_str!("lexical/tests/fixtures/bun-source-index.json"))
                .unwrap();
        for fixture in fixtures {
            let folded = case_fold(&fixture.input);
            assert_eq!(folded, fixture.folded);
            assert_eq!(
                terms(&folded).into_iter().collect::<Vec<_>>(),
                fixture.terms
            );
        }
    }
}
