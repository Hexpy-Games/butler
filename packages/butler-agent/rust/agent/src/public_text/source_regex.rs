//! Regular expressions whose patterns are fixed in this crate's source.
//!
//! Every call site passes a string literal (or, for the allowlisted composed
//! patterns, a pattern built only from constants), and
//! `tests::every_fixed_pattern_compiles` compiles each one. A pattern that
//! fails to compile is therefore a build-time test failure, not a runtime
//! error path, which is why these helpers return `Regex` directly.

use regex::{Regex, RegexBuilder};

/// Compiles a pattern fixed in this crate's source.
#[expect(
    clippy::expect_used,
    reason = "source-fixed pattern; every call site is compiled by tests::every_fixed_pattern_compiles"
)]
pub(crate) fn fixed_regex(pattern: &str) -> Regex {
    Regex::new(pattern).expect("source-fixed regex pattern compiles")
}

/// Compiles a case-insensitive pattern fixed in this crate's source.
#[expect(
    clippy::expect_used,
    reason = "source-fixed pattern; every call site is compiled by tests::every_fixed_pattern_compiles"
)]
pub(crate) fn fixed_regex_ci(pattern: &str) -> Regex {
    RegexBuilder::new(pattern)
        .case_insensitive(true)
        .build()
        .expect("source-fixed regex pattern compiles")
}

#[cfg(test)]
mod tests;
