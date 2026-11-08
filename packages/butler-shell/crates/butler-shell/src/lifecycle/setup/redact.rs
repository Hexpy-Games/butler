//! Diagnostics redaction (`sanitizeDiagnosticsValue`, `redactDiagnosticsText`,
//! `redactDiagnosticsPath` in `setup-bridge.mjs`): secrets and personal paths never leave
//! redacted. A rule that fails to compile redacts the whole text instead of passing it through.
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value};

/// The text rules, applied in order. The absolute-path rule is JS's `/(?!\/)` without lookahead.
const RULES: [(&str, &str); 9] = [
    (
        r"(?i)(?-u:\b)Bearer\s+[A-Za-z0-9._~+/=-]{8,}",
        "Bearer [redacted-token]",
    ),
    (
        r"(?-u:\b)[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?(?-u:\b)",
        "[redacted-token]",
    ),
    (r#"~[\\/][^"'\n\r\t,)]+"#, "[redacted-path]"),
    (r#"[A-Za-z]:\\Users\\[^"'\n\r\t,)]+"#, "[redacted-path]"),
    (r#"\\Users\\[^"'\n\r\t,)]+"#, "[redacted-path]"),
    (r#"/Users/[^"'\n\r\t,)]+"#, "[redacted-path]"),
    (r#"/private/[^"'\n\r\t,)]+"#, "[redacted-path]"),
    (
        r#"(^|[=:\s'"(])/[^/ "'\n\r\t,)][^ "'\n\r\t,)]*"#,
        "${1}[redacted-path]",
    ),
    (r"[A-Za-z0-9_-]{32,}", "[redacted-token]"),
];

static COMPILED: LazyLock<Option<Vec<(Regex, &'static str)>>> = LazyLock::new(|| {
    RULES
        .iter()
        .map(|(pattern, with)| Regex::new(pattern).ok().map(|rule| (rule, *with)))
        .collect()
});

/// `redactDiagnosticsText`.
pub(super) fn text(value: &str) -> String {
    let Some(rules) = COMPILED.as_ref() else {
        return "[redacted]".to_owned();
    };
    let mut out = value.to_owned();
    for (rule, with) in rules {
        out = rule.replace_all(&out, *with).into_owned();
    }
    out
}

/// `redactDiagnosticsPath`. Any drive-letter path is redacted, not only `C:\Users\…`.
fn path(value: &str) -> String {
    if value.contains(".app/Contents/Resources") {
        return "[app-resource]".to_owned();
    }
    if value.starts_with("app/") || value.starts_with("runtime/") {
        return value.to_owned();
    }
    let normalized = value.replace('\\', "/");
    let bytes = normalized.as_bytes();
    let drive =
        bytes.first().is_some_and(u8::is_ascii_alphabetic) && bytes.get(1..3) == Some(b":/");
    if normalized.starts_with('/') || normalized.starts_with("~/") || drive {
        return "[redacted-path]".to_owned();
    }
    text(value)
}

/// `sanitizeDiagnosticsValue`.
pub(super) fn value(raw: &Value) -> Value {
    match raw {
        Value::String(string) => Value::String(text(string)),
        Value::Array(items) => Value::Array(items.iter().map(value).collect()),
        Value::Object(fields) => Value::Object(object(fields)),
        other => other.clone(),
    }
}

fn object(fields: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    for (key, raw) in fields {
        let lower = key.to_ascii_lowercase();
        let has = |words: &[&str]| words.iter().any(|word| lower.contains(word));
        if key == "raw_text_included"
            || has(&[
                "stack",
                "trace",
                "stdout",
                "stderr",
                "raw_output",
                "raw_error",
            ])
        {
            continue;
        }
        if let (true, Value::String(code)) = (lower.ends_with("code"), raw) {
            let safe = code
                .chars()
                .map(|c| {
                    if c.is_ascii_alphanumeric() || "_:-".contains(c) {
                        c
                    } else {
                        '_'
                    }
                })
                .take(80)
                .collect();
            out.insert(key.clone(), Value::String(safe));
        } else if has(&["token", "secret", "authorization", "password", "credential"]) {
            let kept = if raw.is_boolean() {
                raw.clone()
            } else {
                "[redacted]".into()
            };
            out.insert(key.clone(), kept);
        } else if let (true, Value::String(file)) =
            (has(&["path", "file", "dir", "home", "root", "cwd"]), raw)
        {
            out.insert(key.clone(), Value::String(path(file)));
        } else {
            out.insert(key.clone(), value(raw));
        }
    }
    out.insert("raw_text_included".into(), Value::Bool(false));
    out
}

/// Redacts every string of already-structured records (crash records), keeping their keys.
pub(super) fn strings(raw: &Value) -> Value {
    match raw {
        Value::String(string) => Value::String(text(string)),
        Value::Array(items) => Value::Array(items.iter().map(strings).collect()),
        Value::Object(fields) => Value::Object(
            fields
                .iter()
                .map(|(key, field)| (key.clone(), strings(field)))
                .collect(),
        ),
        other => other.clone(),
    }
}
