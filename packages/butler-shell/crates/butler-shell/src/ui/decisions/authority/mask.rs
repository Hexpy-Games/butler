//! `app/maskActionSecrets.ts`: credential values in an action's text become `••••`.
use std::sync::LazyLock;

use regex::{Captures, Regex};

const MASK: &str = "••••";
// JavaScript's `\w` and `\d` are ASCII only; the classes are spelled out to match.
const NAME: &str = r"(?:[A-Za-z0-9_-]*[_-])?(?:token|secret|password|passwd|pwd|api[_-]key|apikey|access[_-]key|private[_-]key|client[_-]secret)(?:[_-][A-Za-z0-9_-]*)?";
const FIELD: &str = r"(?:[A-Za-z0-9_-]*[_-])?(?:token|secret|password|passwd|pwd|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|authorization)";
const VALUE: &str = r#"("[^"\n]*"|'[^'\n]*'|[^\s&;"'`]+)"#;
const FIELD_VALUE: &str = r#"("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|[^\s,}\]"'`]+)"#;
const JOINED: &str =
    r"[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|PWD|APIKEY|ACCESSKEY|PRIVATEKEY)";
const EDGE: &str = r"(^|[^A-Za-z0-9_/-])";

/// A rule: its regex, and how many groups stay before the mask and after it.
static RULES: LazyLock<Vec<(Regex, usize, usize)>> = LazyLock::new(|| {
    let rules = [
        (format!(r"{EDGE}({JOINED})(=){VALUE}"), 3, 0),
        (format!(r#"(?i)(")({FIELD})("\s*:\s*){FIELD_VALUE}"#), 3, 0),
        (format!(r"(?i)(')({FIELD})('\s*:\s*){FIELD_VALUE}"), 3, 0),
        (
            format!(r"(?i){EDGE}({FIELD})(\s*:\s*(?:bearer\s+|basic\s+)?){FIELD_VALUE}"),
            3,
            0,
        ),
        (format!(r"(?i){EDGE}({NAME})(=){VALUE}"), 3, 0),
        (format!(r"(?i)(^|\s)(--{NAME})(=|\s+){VALUE}"), 3, 0),
        (
            r"(?i)(\b[a-z][a-z0-9+.-]*://[^\s/@:]+:)[^\s/@]+(@)".to_owned(),
            1,
            1,
        ),
    ];
    rules
        .into_iter()
        .filter_map(|(pattern, before, after)| Some((Regex::new(&pattern).ok()?, before, after)))
        .collect()
});

static TOKEN: LazyLock<Option<Regex>> = LazyLock::new(|| {
    Regex::new(r"(?:sk-|ghp_|gho_|github_pat_|xox[bp]-)[a-zA-Z0-9_-]+|AKIA[A-Z0-9]{16}").ok()
});

fn masked(caps: &Captures<'_>, before: usize, after: usize) -> String {
    let group = |i: usize| caps.get(i).map_or("", |m| m.as_str());
    let mut out: String = (1..=before).map(group).collect();
    out.push_str(MASK);
    out.extend((before + 1..=before + after).map(group));
    out
}

/// A token not joined to a word, path or dotted name on either side (`(?<![\w/.-])`, `(?![\w/.-])`).
fn mask_tokens(text: &str, token: &Regex) -> String {
    let joined = |c: char| c.is_ascii_alphanumeric() || matches!(c, '_' | '/' | '.' | '-');
    let mut out = String::new();
    let mut last = 0;
    for found in token.find_iter(text) {
        let before = text[..found.start()].chars().next_back();
        let after = text[found.end()..].chars().next();
        if before.is_some_and(joined) || after.is_some_and(joined) {
            continue;
        }
        out.push_str(&text[last..found.start()]);
        out.push_str(MASK);
        last = found.end();
    }
    out.push_str(&text[last..]);
    out
}

/// Redact credential values while preserving the exact action and argument names.
pub(super) fn mask_action_secrets(text: &str) -> String {
    let mut text = text.to_owned();
    for (rule, before, after) in RULES.iter() {
        text = rule
            .replace_all(&text, |caps: &Captures<'_>| masked(caps, *before, *after))
            .into_owned();
    }
    match TOKEN.as_ref() {
        Some(token) => mask_tokens(&text, token),
        None => text,
    }
}
