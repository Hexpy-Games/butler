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
    let span = placeholders.hide(&rest[..end]);
    span.split_whitespace().collect::<Vec<_>>().join(" ")
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
