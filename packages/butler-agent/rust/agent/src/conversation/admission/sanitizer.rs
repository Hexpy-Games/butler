use serde_json::{Map, Value};
use std::sync::LazyLock;

use regex::Regex;

const ARGUMENT_SCHEMA: &str = "butler.tool-call-arguments-transcript.v1";
const EVIDENCE_SCHEMA: &str = "butler.tool-result-evidence-transcript.v1";

static UNSAFE_KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?iu)(?:raw[_-]?(?:arguments(?:[_-]?delta)?|output|stdout|stderr)|stdout|stderr|api[_-]?key|token|secret|password|passphrase|authorization|credential|credentials|access[_-]?token|refresh[_-]?token|private[_-]?key|session[_-]?key|cookie|set-cookie)").unwrap()
});
static SENSITIVE_KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?iu)(?:api[_-]?key|token|secret|password|passphrase|authorization|auth|credential|credentials|access[_-]?token|refresh[_-]?token|private[_-]?key|session[_-]?key|cookie|set-cookie)").unwrap()
});
const NON_JS_WORD: &str = r"[^A-Za-z0-9_\u{17f}\u{212a}]";
static THINK_BLOCK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"(?isu)<think{NON_JS_WORD}[^>]*>.*?</think>")).unwrap());
static THINK_TAG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"(?iu)</?think{NON_JS_WORD}[^>]*>")).unwrap());
static PRIVATE_SENTINEL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?iu)SECRET[_-]?TOKEN|raw prompt text|(?:api[_-]?key|secret|token|authorization|bearer)\s*[:=]").unwrap()
});

pub(super) fn safe_tool_content(
    payload: Option<&Map<String, Value>>,
    kind: &str,
) -> Map<String, Value> {
    let mut out = Map::new();
    out.insert("eventKind".into(), kind.into());
    for (source, target) in [("toolCallId", "toolCallId"), ("workBlockId", "workBlockId")] {
        if let Some(value) = text(payload.and_then(|v| v.get(source))) {
            out.insert(target.into(), value.into());
        }
    }
    for (source, target) in [
        ("safeToolName", "safeToolName"),
        ("toolName", "safeToolName"),
        ("safeLabel", "safeLabel"),
        ("inputLabel", "safeInputLabel"),
        ("workBlockLabel", "workBlockLabel"),
        ("status", "status"),
    ] {
        if !out.contains_key(target)
            && let Some(value) = safe_optional(payload.and_then(|v| v.get(source)))
        {
            out.insert(target.into(), value.into());
        }
    }
    if kind == "tool_call.finalized"
        && let Some(value) = safe_arguments(payload.and_then(|v| v.get("arguments")))
    {
        out.insert("arguments".into(), Value::Object(value));
    }
    if matches!(kind, "tool_result.finalized" | "tool_result.failed") {
        if let Some(value) = payload.and_then(|v| v.get("ok")).and_then(Value::as_bool) {
            out.insert("ok".into(), value.into());
        }
        if let Some(value) = safe_result(payload.and_then(|v| v.get("result"))) {
            out.insert("result".into(), Value::Object(value));
        }
        if let Some(value) = safe_optional(payload.and_then(|v| v.get("safeError"))) {
            out.insert("error".into(), value.into());
        }
        if let Some(value) = safe_observation(payload.and_then(|v| v.get("safeObservation"))) {
            out.insert("observation".into(), Value::Object(value));
        }
    }
    out
}

fn safe_arguments(value: Option<&Value>) -> Option<Map<String, Value>> {
    let record = value?.as_object()?;
    if record.get("schema_version")?.as_str() != Some(ARGUMENT_SCHEMA) {
        return None;
    }
    let safe = record
        .get("safe_arguments")
        .and_then(Value::as_object)
        .map(remove_unsafe)
        .unwrap_or_default();
    let keys = safe
        .keys()
        .take(24)
        .map(|v| Value::String(identifier(v, "argument")))
        .collect();
    let mut arguments = Map::new();
    for (key, value) in safe.iter().take(24) {
        arguments.insert(identifier(key, "argument"), safe_argument(key, value, 0));
    }
    let mut out = Map::new();
    out.insert("schema_version".into(), ARGUMENT_SCHEMA.into());
    out.insert("argument_keys".into(), Value::Array(keys));
    out.insert("safe_arguments".into(), Value::Object(arguments));
    Some(out)
}
fn safe_result(value: Option<&Value>) -> Option<Map<String, Value>> {
    let record = value?.as_object()?;
    if record.get("schema_version")?.as_str() != Some(EVIDENCE_SCHEMA) {
        return None;
    }
    let mut out = Map::new();
    out.insert("schema_version".into(), EVIDENCE_SCHEMA.into());
    for key in [
        "evidence_capability_receipts",
        "evidence_receipts",
        "rejected_evidence_capability_receipts",
    ] {
        if let Some(items) = record.get(key).and_then(Value::as_array) {
            out.insert(
                key.into(),
                Value::Array(
                    items
                        .iter()
                        .take(48)
                        .map(|v| safe_evidence(v, 0))
                        .filter(|v| !v.is_null())
                        .collect(),
                ),
            );
        }
    }
    if let Some(items) = record.get("evidence_limitations").and_then(Value::as_array) {
        out.insert(
            "evidence_limitations".into(),
            Value::Array(
                items
                    .iter()
                    .filter_map(|v| safe_optional(Some(v)).map(Value::String))
                    .collect(),
            ),
        );
    }
    if let Some(value) = record
        .get("completion_obligation_evidence")
        .map(|v| safe_evidence(v, 0))
        .and_then(|v| v.as_object().cloned())
    {
        out.insert(
            "completion_obligation_evidence".into(),
            Value::Object(value),
        );
    }
    Some(out)
}
fn safe_observation(value: Option<&Value>) -> Option<Map<String, Value>> {
    let record = value?.as_object()?;
    let mut out = Map::new();
    for key in ["observationId", "causedByToolCallId", "createdAt"] {
        if let Some(value) = text(record.get(key)) {
            out.insert(key.into(), value.into());
        }
    }
    for key in ["kind", "summary", "modelVisibleContent"] {
        if let Some(value) = safe_optional(record.get(key)) {
            out.insert(key.into(), value.into());
        }
    }
    if record.get("visibility").and_then(Value::as_str) == Some("model") {
        out.insert("visibility".into(), "model".into());
    }
    Some(out)
}
fn safe_evidence(value: &Value, depth: usize) -> Value {
    if depth > 6 {
        return "[redacted]".into();
    }
    match value {
        Value::String(value) => safe_public(value, "[redacted]").into(),
        Value::Number(_) | Value::Bool(_) => value.clone(),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .take(48)
                .map(|v| safe_evidence(v, depth + 1))
                .filter(|v| !v.is_null())
                .collect(),
        ),
        Value::Object(record) => {
            let mut out = Map::new();
            for (key, value) in record.iter().take(48) {
                if unsafe_key(key) {
                    continue;
                }
                out.insert(identifier(key, "field"), safe_evidence(value, depth + 1));
            }
            Value::Object(out)
        }
        _ => Value::Null,
    }
}
fn safe_argument(key: &str, value: &Value, depth: usize) -> Value {
    if sensitive_key(key) || depth > 2 {
        return "[redacted]".into();
    }
    match value {
        Value::String(v) => safe_public(v, "[redacted]").into(),
        Value::Number(_) | Value::Bool(_) => value.clone(),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .take(12)
                .map(|v| safe_argument(key, v, depth + 1))
                .collect(),
        ),
        Value::Object(record) => {
            let mut out = Map::new();
            for (k, v) in record.iter().take(16) {
                out.insert(identifier(k, "field"), safe_argument(k, v, depth + 1));
            }
            Value::Object(out)
        }
        _ => Value::Null,
    }
}
fn remove_unsafe(record: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    for (key, value) in record {
        if unsafe_key(key) {
            continue;
        }
        out.insert(key.clone(), remove_unsafe_value(value));
    }
    out
}
fn remove_unsafe_value(value: &Value) -> Value {
    match value {
        Value::Object(child) => Value::Object(remove_unsafe(child)),
        Value::Array(items) => Value::Array(items.iter().map(remove_unsafe_value).collect()),
        _ => value.clone(),
    }
}
fn unsafe_key(key: &str) -> bool {
    js_bounded_match(&UNSAFE_KEY, key)
}
fn sensitive_key(key: &str) -> bool {
    js_bounded_match(&SENSITIVE_KEY, key)
}
fn js_bounded_match(pattern: &Regex, value: &str) -> bool {
    pattern
        .find_iter(value)
        .any(|found| js_boundary(value, found.start()) && js_boundary(value, found.end()))
}
fn js_boundary(value: &str, offset: usize) -> bool {
    let word = |character: char| {
        character.is_ascii_alphanumeric()
            || character == '_'
            || matches!(character, '\u{17f}' | '\u{212a}')
    };
    value[..offset].chars().next_back().is_some_and(word)
        != value[offset..].chars().next().is_some_and(word)
}
fn safe_optional(value: Option<&Value>) -> Option<String> {
    let text = crate::public_text::trim_js_whitespace(value?.as_str()?);
    if text.is_empty() {
        None
    } else {
        let value = safe_public(text, "");
        (!value.is_empty()).then(|| utf16_prefix(&value, 240))
    }
}
fn safe_public(value: &str, fallback: &str) -> String {
    let stripped = strip_think(value);
    let value = crate::public_text::sanitize_public_text(&stripped, fallback);
    if value.is_empty() || PRIVATE_SENTINEL.is_match(&value) {
        fallback.into()
    } else {
        utf16_prefix(&value, 320)
    }
}
fn strip_think(value: &str) -> String {
    let without_blocks = THINK_BLOCK.replace_all(value, "");
    THINK_TAG.replace_all(&without_blocks, "").into_owned()
}
fn identifier(value: &str, fallback: &str) -> String {
    let safe = safe_optional(Some(&Value::String(value.into())))
        .unwrap_or_else(|| fallback.into())
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-");
    utf16_prefix(&safe, 120)
}
fn utf16_prefix(value: &str, max: usize) -> String {
    let mut units = 0;
    value
        .chars()
        .take_while(|c| {
            let next = units + c.len_utf16();
            if next > max {
                false
            } else {
                units = next;
                true
            }
        })
        .collect()
}
fn text(value: Option<&Value>) -> Option<String> {
    value?
        .as_str()
        .map(crate::public_text::trim_js_whitespace)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transcript_policy_redacts_exact_keys_and_keeps_word_nonmatches() {
        let payload = serde_json::json!({
            "toolCallId":"call-1",
            "arguments": {
                "schema_version": ARGUMENT_SCHEMA,
                "safe_arguments": {
                    "token": "secret",
                    "tokenized": "public",
                    "nested": [{"raw_stdout":"private", "result":"safe"}]
                }
            }
        });
        let safe = safe_tool_content(payload.as_object(), "tool_call.finalized");
        let encoded = crate::json::stringify(&Value::Object(safe)).unwrap();
        assert!(!encoded.contains("secret"));
        assert!(!encoded.contains("private"));
        assert!(encoded.contains("tokenized"));
        assert!(encoded.contains("public"));
        assert!(encoded.contains("result"));
    }

    #[test]
    fn scalar_safe_utf16_budget_stops_before_split_astral_character() {
        let input = format!("{}😀tail", "a".repeat(319));
        let safe = safe_public(&input, "");
        assert_eq!(safe.encode_utf16().count(), 319);
        assert_eq!(safe, "a".repeat(319));
    }

    #[test]
    fn evidence_limitations_preserve_the_source_unbounded_array_policy() {
        let limitations = (0..9)
            .map(|index| Value::String(format!("limitation-{index}")))
            .collect::<Vec<_>>();
        let payload = serde_json::json!({
            "result": {
                "schema_version": EVIDENCE_SCHEMA,
                "evidence_limitations": limitations,
            }
        });
        let safe = safe_tool_content(payload.as_object(), "tool_result.finalized");
        assert_eq!(
            safe["result"]["evidence_limitations"]
                .as_array()
                .unwrap()
                .len(),
            9
        );
    }
}
