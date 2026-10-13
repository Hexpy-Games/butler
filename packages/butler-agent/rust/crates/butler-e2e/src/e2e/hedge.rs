//! Non-gating lint for handback and avoidance language in live answers.
use std::sync::OnceLock;

use regex::Regex;

/// Names of hedge patterns found in an answer, once per pattern.
#[expect(clippy::expect_used, reason = "literal regex patterns are valid")]
pub fn hits(text: &str) -> Vec<&'static str> {
    static PATTERNS: OnceLock<Vec<(&str, Regex)>> = OnceLock::new();
    PATTERNS
        .get_or_init(|| {
            [
                (
                    "verify_yourself",
                    r"verify (it |this |that |them )?(yourself|on your own)",
                ),
                ("please_check", r"\bplease (check|verify|confirm)\b"),
                (
                    "did_not_check",
                    r"\bI (did not|didn't|could not|couldn't) (check|verify|confirm)",
                ),
                (
                    "not_confirmed",
                    r"\b(is|are|was|were) not (confirmed|verified)\b",
                ),
                ("unconfirmed", r"\bunconfirmed\b"),
                (
                    "cannot_assert",
                    r"\bI (won't|will not|cannot|can't) (assert|guarantee)",
                ),
                ("seemed_unsafe", r"\b(looked|seemed) (suspicious|unsafe)\b"),
                ("ko_direct_check", r"직접 확인"),
                ("ko_please_check", r"확인해 (보세요|주세요|보시)"),
                ("ko_not_checked", r"확인(하지|되지) (않았|않은|못했)"),
                ("ko_not_verified", r"검증(하지|되지) (않았|못했)"),
                ("ko_cannot_assert", r"단정(하지|할 수) (않|없)"),
                (
                    "ko_suspicious_avoidance",
                    r"의심스러[워운].{0,20}(건드리지|손대지|열지)",
                ),
            ]
            .into_iter()
            .map(|(name, pattern)| {
                (
                    name,
                    Regex::new(&format!("(?i){pattern}")).expect("static hedge pattern"),
                )
            })
            .collect()
        })
        .iter()
        .filter_map(|(name, pattern)| pattern.is_match(text).then_some(*name))
        .collect()
}
