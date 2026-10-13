//! Titles contain human text, never protocol markers or internal role names.
use super::{fixed_regex, fixed_regex_ci, sanitize_public_text};
use regex::Regex;
use std::sync::LazyLock;

static MARKERS: LazyLock<Regex> = LazyLock::new(|| fixed_regex(r"[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+"));
static ROLES: LazyLock<Regex> = LazyLock::new(|| fixed_regex_ci(r"\bsteward\b|스튜어드"));

/// Removes protocol markers and internal role names before a title reaches the UI.
pub fn public_title(value: &str, fallback: &str) -> String {
    let markers = MARKERS.replace_all(value, "");
    let roles = ROLES.replace_all(&markers, "");
    let changed = markers.as_ref() != value || roles.as_ref() != markers.as_ref();
    let title = sanitize_public_text(&roles, "");
    let title = if changed {
        title.trim_matches(|c: char| {
            c.is_whitespace() || matches!(c, '…' | '.' | '-' | ':' | '_' | '"' | '\'' | '`' | '#')
        })
    } else {
        title.as_str()
    };
    if title.is_empty() {
        return if fallback.is_empty() {
            String::new()
        } else {
            public_title(fallback, "")
        };
    }
    title.to_owned()
}
