//! Field-level sanitization of JSON bodies (usage and token endpoints) and
//! the matching lint, which decodes every JSON body in a cassette (escapes
//! included) before it looks at a field.
//!
//! - Identifier fields (`account_id`, `chatgpt_account_id`, `orgId`,
//!   `organizationId`, `user_id`, `email`, … in any case or separator
//!   style, string or number) → `{{ACCOUNT}}` / `{{EMAIL}}`; a bare `id`
//!   only when it holds an identifier (a UUID, a `user-`/`org-`/`acct`
//!   id, or a long number).
//! - Token fields (`access_token`, `refresh_token`, `id_token`) and
//!   `authorization` values → `{{TOKEN}}`.
//! - Absolute reset times (`nextResetTime` in ms; `reset_at`/`resets_at` in
//!   s) → `{{EPOCH_MS+<delta>}}` / `{{EPOCH_S+<delta>}}` relative to the
//!   recording time and rounded to the hour, and `reset_after_seconds` →
//!   rounded to the hour. Replay turns them back into times relative to the
//!   replay (`expand_times`), so no cassette pins a subscription anniversary.

use std::sync::OnceLock;

use regex::Regex;
use serde_json::{Map, Value};

const HOUR_MS: i64 = 3_600_000;
const HOUR_S: i64 = 3_600;

/// A field name's letters, lowercased (`chatgpt_account_id` → `chatgptaccountid`).
fn normalized(key: &str) -> String {
    key.chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|character| character.to_ascii_lowercase())
        .collect()
}

fn is_identifier_field(key: &str) -> bool {
    let key = normalized(key);
    key == "email"
        || [
            "accountid",
            "userid",
            "workspaceid",
            "orgid",
            "organizationid",
        ]
        .iter()
        .any(|suffix| key.ends_with(suffix))
}

fn is_token_field(key: &str) -> bool {
    matches!(
        normalized(key).as_str(),
        "accesstoken" | "refreshtoken" | "idtoken" | "authorization"
    )
}

fn is_placeholder(value: &Value) -> bool {
    match value {
        Value::String(text) => text.is_empty() || text.starts_with("{{"),
        Value::Null => true,
        _ => false,
    }
}

/// Whether a bare `id` value identifies an account or user.
fn identifying_id(value: &Value) -> bool {
    static SHAPE: OnceLock<Option<Regex>> = OnceLock::new();
    let shape = SHAPE.get_or_init(|| {
        Regex::new(
            r"(?i)^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?:user|org|acct|account)[-_].+|\d{6,})$",
        )
        .ok()
    });
    match value {
        Value::Number(number) => number.as_u64().is_some_and(|number| number >= 100_000),
        Value::String(text) => shape.as_ref().is_some_and(|shape| shape.is_match(text)),
        _ => false,
    }
}

/// Replaces identifier, token and absolute reset-time values anywhere in a
/// JSON value; `now_ms` is the recording time.
pub(super) fn redact(value: &mut Value, now_ms: i64) -> bool {
    match value {
        Value::Object(object) => redact_object(object, now_ms),
        Value::Array(items) => {
            let mut changed = false;
            for item in items {
                changed |= redact(item, now_ms);
            }
            changed
        }
        _ => false,
    }
}

fn redact_object(object: &mut Map<String, Value>, now_ms: i64) -> bool {
    let mut changed = false;
    for (key, field) in object.iter_mut() {
        let replacement = if is_placeholder(field) {
            None
        } else if is_identifier_field(key) || (key == "id" && identifying_id(field)) {
            Some(Value::String(
                if normalized(key) == "email" {
                    "{{EMAIL}}"
                } else {
                    "{{ACCOUNT}}"
                }
                .into(),
            ))
        } else if is_token_field(key) && field.is_string() {
            Some(Value::String("{{TOKEN}}".into()))
        } else {
            relative_time(key, field, now_ms)
        };
        match replacement {
            Some(replacement) => {
                *field = replacement;
                changed = true;
            }
            None => changed |= redact(field, now_ms),
        }
    }
    changed
}

/// The relative replacement of a reset-time field, `None` for other fields.
fn relative_time(key: &str, field: &Value, now_ms: i64) -> Option<Value> {
    let number = field.as_f64().filter(|number| number.is_finite())?;
    let round = |value: i64, unit: i64| (value + unit / 2).div_euclid(unit) * unit;
    match normalized(key).as_str() {
        "nextresettime" if number >= 1e12 => {
            let delta = round(float_to_i64(number) - now_ms, HOUR_MS);
            Some(Value::String(format!("{{{{EPOCH_MS{delta:+}}}}}")))
        }
        "resetat" | "resetsat" if number >= 1e9 => {
            let delta = round(float_to_i64(number) - now_ms / 1000, HOUR_S);
            Some(Value::String(format!("{{{{EPOCH_S{delta:+}}}}}")))
        }
        "resetafterseconds" => {
            let rounded = round(float_to_i64(number), HOUR_S);
            (rounded != float_to_i64(number)).then(|| Value::from(rounded))
        }
        _ => None,
    }
}

#[expect(
    clippy::cast_possible_truncation,
    reason = "epoch times and second counts are far inside i64; `as` saturates"
)]
fn float_to_i64(value: f64) -> i64 {
    value as i64
}

/// Replay: `"{{EPOCH_MS+N}}"` / `"{{EPOCH_S+N}}"` (with their quotes) →
/// the replay time plus `N`, as a JSON number.
pub(super) fn expand_times(text: &str, now_ms: i64) -> String {
    static PATTERN: OnceLock<Option<Regex>> = OnceLock::new();
    let Some(pattern) = PATTERN
        .get_or_init(|| Regex::new(r#"\\?"\{\{EPOCH_(MS|S)([+-]\d+)\}\}\\?""#).ok())
        .as_ref()
    else {
        return text.to_owned();
    };
    pattern
        .replace_all(text, |captures: &regex::Captures<'_>| {
            let delta: i64 = captures[2].parse().unwrap_or(0);
            let base = if &captures[1] == "MS" {
                now_ms
            } else {
                now_ms / 1000
            };
            base.saturating_add(delta).to_string()
        })
        .into_owned()
}

/// Lint findings of every JSON body in one cassette file: the file, its
/// string values that are JSON, and the `data:` lines of SSE bodies.
pub(super) fn lint(text: &str) -> Vec<String> {
    let mut findings = Vec::new();
    if let Ok(value) = serde_json::from_str::<Value>(text) {
        lint_value(&value, &mut findings, 0);
    }
    findings
}

fn lint_value(value: &Value, findings: &mut Vec<String>, depth: usize) {
    if depth > 16 {
        return;
    }
    match value {
        Value::Object(object) => {
            for (key, field) in object {
                if let Some(finding) = field_finding(key, field) {
                    findings.push(finding);
                }
                lint_value(field, findings, depth + 1);
            }
        }
        Value::Array(items) => {
            for item in items {
                lint_value(item, findings, depth + 1);
            }
        }
        Value::String(text) => {
            for body in embedded_json(text) {
                lint_value(&body, findings, depth + 1);
            }
        }
        _ => {}
    }
}

fn field_finding(key: &str, field: &Value) -> Option<String> {
    if is_placeholder(field) {
        return None;
    }
    let label = if is_identifier_field(key) && !field.is_object() && !field.is_array() {
        "identifier field"
    } else if key == "id" && identifying_id(field) {
        "identifying id"
    } else if is_token_field(key) && field.is_string() {
        "token field"
    } else if relative_time(key, field, 0).is_some() && normalized(key) != "resetafterseconds" {
        "absolute reset time"
    } else {
        return None;
    };
    Some(format!("{label}: {key}"))
}

/// JSON bodies inside a string: the whole string, or its SSE `data:` lines.
fn embedded_json(text: &str) -> Vec<Value> {
    let trimmed = text.trim_start();
    if (trimmed.starts_with('{') || trimmed.starts_with('['))
        && let Ok(value) = serde_json::from_str(trimmed)
    {
        return vec![value];
    }
    text.lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .filter_map(|data| serde_json::from_str(data.trim()).ok())
        .collect()
}
