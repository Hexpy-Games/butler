//! Generated Unicode 15.1 full C+F case-fold table consumer.
//!
//! Source: projection/unicode.ts, itself generated from CaseFolding-15.1.0.txt
//! source SHA-256 4e55acfdc32825a22e87670e9056a3bf94ad7c5400065778e9e10f8314372bcf.
//! Compact table SHA-256 cf14626a446d678dcc9378df5ffde31801d2b4d9b0d36fa87f721a6911f3e50a.
//! The checked-in table and source hash are the reviewed compatibility record.

use std::sync::OnceLock;

use indexmap::IndexSet;
use unicode_normalization::UnicodeNormalization;
use unicode_segmentation::UnicodeSegmentation;

static TABLE: OnceLock<Vec<(u32, &'static str)>> = OnceLock::new();

pub(in crate::cognition) fn case_fold(value: &str) -> String {
    let table = table();
    let mut folded = String::with_capacity(value.len());
    for character in value.chars() {
        match table.binary_search_by_key(&(character as u32), |entry| entry.0) {
            Ok(index) => folded.push_str(table[index].1),
            Err(_) => folded.push(character),
        }
    }
    folded.nfc().collect()
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

#[expect(
    clippy::expect_used,
    reason = "bundled generated table; every row is parsed by tests::bundled_case_fold_table_parses"
)]
fn table() -> &'static [(u32, &'static str)] {
    TABLE.get_or_init(|| {
        include_str!("casefold-15.1.tsv")
            .lines()
            .map(|line| {
                let (code, value) = line.split_once('\t').expect("generated case-fold row");
                (
                    u32::from_str_radix(code, 16).expect("generated code point"),
                    value,
                )
            })
            .collect()
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn bundled_case_fold_table_parses() {
        assert!(!super::table().is_empty());
    }
}
