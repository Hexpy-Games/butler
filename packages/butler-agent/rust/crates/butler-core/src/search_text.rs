//! Frozen Script15 search analysis shared by Cognition's episode index and App
//! search, over the bundled Unicode 15.1 full case fold.

mod tokenize;
mod unicode;

pub use unicode::case_fold;

/// Script15 analysis for an indexed text field, shared with App search.
pub fn analyze_search_field(text: &str) -> String {
    tokenize::field(text)
}
/// Escaped Script15 FTS query using the same language rules as its fields.
pub fn analyze_search_query(text: &str) -> String {
    tokenize::query(text)
}
/// The Script15 FTS expression of a memory recall cue.
pub fn analyze_recall_query(text: &str) -> String {
    tokenize::recall_query(text)
}

#[cfg(test)]
mod tests {
    /// Pure-logic table: the bundled full case-fold table parses and the
    /// Script15 analysis keeps its frozen tokens.
    // test-category: pure-logic
    #[test]
    fn case_fold_table_and_frozen_analysis() {
        super::unicode::tests::bundled_case_fold_table_parses();
        super::tokenize::assert_frozen_analysis();
    }
}
