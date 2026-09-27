//! Match-key extraction from provider request bodies (Responses API and Chat
//! Completions shapes).

use serde_json::Value;

use super::cassette::MatchKey;
use super::sanitize::Placeholders;

pub fn key(path: &str, body: &Value, placeholders: &Placeholders) -> MatchKey {
    let effort = body["reasoning"]["effort"]
        .as_str()
        .or_else(|| body["reasoning_effort"].as_str())
        .map(str::to_owned);
    let items = body["input"]
        .as_array()
        .or_else(|| body["messages"].as_array())
        .cloned()
        .unwrap_or_default();
    // The user's request is the last user item carrying `User request:`;
    // later user-role items are product context updates (e.g. "Updated
    // current Work context"), which embed ids and tool arguments.
    let last_user = items
        .iter()
        .rposition(|item| item["role"] == "user" && text_of(item).contains("User request:"))
        .or_else(|| items.iter().rposition(|item| item["role"] == "user"));
    let user_request = last_user
        .map(|index| user_request(&text_of(&items[index]), placeholders))
        .unwrap_or_default();
    let round = last_user
        .map(|index| items[index + 1..].iter().filter_map(item_kind).collect())
        .unwrap_or_default();
    MatchKey {
        path: path.to_owned(),
        model: body["model"].as_str().unwrap_or_default().to_owned(),
        effort,
        user_request,
        round,
    }
}

fn text_of(item: &Value) -> String {
    match &item["content"] {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|part| part["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// The span between `User request:` and `Current scope:` (the rest of the
/// user message carries per-run times, hashes, ids and paths).
pub fn user_request(text: &str, placeholders: &Placeholders) -> String {
    let start = text
        .rfind("User request:")
        .map_or(0, |index| index + "User request:".len());
    let rest = &text[start..];
    let end = rest.find("Current scope:").unwrap_or(rest.len());
    let span = normalize_volatile(&placeholders.hide(&rest[..end]));
    span.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Values the product writes into background prompts that differ on every
/// run (clock readings, consolidation run ids, the local time of day, record
/// digests and uuids) are named, so a recording matches the same request
/// made at another time. Idempotent; also applied to recorded keys on load.
pub fn normalize_volatile(text: &str) -> String {
    static PATTERNS: std::sync::OnceLock<Vec<(regex::Regex, &'static str)>> =
        std::sync::OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| {
        [
            (
                r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})",
                "{{TIME}}",
            ),
            (
                r"\bcr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b",
                "{{RUN_ID}}",
            ),
            (
                r#""time_of_day":\s*"(?:morning|afternoon|evening|night)""#,
                r#""time_of_day": "{{TIME_OF_DAY}}""#,
            ),
            // Content digests and uuids of per-run records (revisions,
            // session and message ids) that a briefing lists as sources.
            (r"\b[0-9a-f]{64}\b", "{{DIGEST}}"),
            (
                r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b",
                "{{UUID}}",
            ),
        ]
        .into_iter()
        .filter_map(|(pattern, name)| regex::Regex::new(pattern).ok().map(|regex| (regex, name)))
        .collect()
    });
    let mut out = text.to_owned();
    for (regex, name) in patterns {
        out = regex.replace_all(&out, *name).into_owned();
    }
    out
}

fn item_kind(item: &Value) -> Option<String> {
    let kind = match (item["role"].as_str(), item["tool_calls"].is_array()) {
        (Some("assistant"), true) => "function_call".to_owned(),
        (Some("assistant"), false) => "message".to_owned(),
        (Some("tool"), _) => "function_call_output".to_owned(),
        (Some(role), _) => role.to_owned(),
        (None, _) => item["type"].as_str()?.to_owned(),
    };
    (kind != "reasoning").then_some(kind)
}
