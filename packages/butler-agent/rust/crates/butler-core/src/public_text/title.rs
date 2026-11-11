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

/// A delegated task's title: the model's safe title, else the request's first line.
pub fn delegation_title(safe_title: Option<&str>, request: &str) -> String {
    if let Some(title) = safe_title
        .map(|title| public_title(title, request))
        .filter(|title| !title.trim().is_empty() && !names_internal_role(title))
    {
        return title;
    }
    let first = request.lines().find(|line| !line.trim().is_empty());
    let first = first.unwrap_or("").split_whitespace().collect::<Vec<_>>();
    let title = first.join(" ");
    if title.chars().count() > 64 {
        format!("{}…", title.chars().take(63).collect::<String>())
    } else {
        title
    }
}
