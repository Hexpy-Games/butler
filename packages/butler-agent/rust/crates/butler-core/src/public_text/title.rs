//! A generated title summarizes human text; it never introduces protocol tokens.
use super::fixed_regex;
use regex::Regex;
use std::sync::LazyLock;

/// Protocol-shaped tokens: upper snake case such as `TASK_DONE`.
static PROTOCOL_TOKEN: LazyLock<Regex> =
    LazyLock::new(|| fixed_regex(r"[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+"));

/// Removes protocol-shaped tokens that `source`, the text the title
/// summarizes, does not contain; tokens the human wrote stay.
pub fn public_title(title: &str, source: &str) -> String {
    let mut changed = false;
    let kept = PROTOCOL_TOKEN.replace_all(title, |token: &regex::Captures<'_>| {
        if source.contains(&token[0]) {
            token[0].to_owned()
        } else {
            changed = true;
            String::new()
        }
    });
    if !changed {
        return title.to_owned();
    }
    kept.trim_matches(|c: char| {
        c.is_whitespace() || matches!(c, '…' | '.' | '-' | ':' | '_' | '"' | '\'' | '`' | '#')
    })
    .to_owned()
}

/// Whether `text` names the internal delegation role, which is never shown.
pub fn names_internal_role(text: &str) -> bool {
    text.contains("스튜어드")
        || text
            .split(|character: char| !character.is_alphanumeric())
            .any(|word| word == "Steward")
}
