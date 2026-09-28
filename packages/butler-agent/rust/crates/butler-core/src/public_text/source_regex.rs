//! Regular expressions whose patterns are fixed in this crate's source.
//!
//! Every call site passes a string literal (or a pattern built only from
//! constants), so a pattern that fails to compile fails the first E2E scenario
//! or test that reaches its call site rather than a user's turn, which is why
//! these helpers return `Regex` directly.

use regex::{Regex, RegexBuilder};

/// Compiles a pattern fixed in this crate's source.
#[expect(
    clippy::expect_used,
    reason = "source-fixed pattern; a malformed one fails the first E2E scenario or test reaching its call site"
)]
pub fn fixed_regex(pattern: &str) -> Regex {
    Regex::new(pattern).expect("source-fixed regex pattern compiles")
}

/// Compiles a case-insensitive pattern fixed in this crate's source.
#[expect(
    clippy::expect_used,
    reason = "source-fixed pattern; a malformed one fails the first E2E scenario or test reaching its call site"
)]
pub fn fixed_regex_ci(pattern: &str) -> Regex {
    RegexBuilder::new(pattern)
        .case_insensitive(true)
        .build()
        .expect("source-fixed regex pattern compiles")
}
