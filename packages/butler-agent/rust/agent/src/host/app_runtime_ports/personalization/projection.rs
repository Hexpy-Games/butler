use serde_json::{Map, Value, json};

use crate::{
    gateway::AppPersonalizationEvent, profile::ClearProfilingResult,
    public_text::trim_js_whitespace,
};

pub(super) fn event(event_type: &str, payload: &Value) -> AppPersonalizationEvent {
    AppPersonalizationEvent {
        event_type: event_type.to_owned(),
        payload: payload.as_object().cloned().unwrap_or_default(),
    }
}

pub(super) fn update_event_payload(
    input: &Value,
    cleared: Option<&ClearProfilingResult>,
) -> Map<String, Value> {
    let Some(input) = input.as_object() else {
        return Map::new();
    };
    let mut payload = Map::new();
    for (key, target) in [("persona", "persona_chars"), ("eol", "eol_chars")] {
        if let Some(value) = input.get(key).and_then(Value::as_str) {
            payload.insert(target.into(), Value::from(bounded_chars(value)));
        }
    }
    if let Some(profile) = input.get("profile").and_then(Value::as_object) {
        let mut fields = profile.keys().cloned().collect::<Vec<_>>();
        fields.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
        payload.insert("profile_fields".into(), json!(fields));
    }
    if let Some(profiling) = input.get("profiling").and_then(Value::as_object) {
        for (source, target) in [
            ("mode", "profiling_mode"),
            ("extractor_model", "profiling_extractor_model"),
            (
                "extractor_reasoning_effort",
                "profiling_extractor_reasoning_effort",
            ),
        ] {
            if let Some(value) = profiling.get(source) {
                payload.insert(target.into(), value.clone());
            }
        }
    }
    if let Some(cleared) = cleared {
        payload.insert(
            "profile_black_box_cleared".into(),
            json!({
                "removed_candidates": cleared.removed_candidates,
                "removed_stable_entries": cleared.removed_stable_entries,
                "removed_runtime_projections": cleared.removed_runtime_projections
            }),
        );
    }
    if let Some(language) = input.get("response_language") {
        payload.insert("response_language".into(), language.clone());
    }
    payload
}

fn bounded_chars(value: &str) -> usize {
    let normalized = value.replace("\r\n", "\n");
    let normalized = trim_js_whitespace(&normalized);
    let mut units = 0;
    normalized
        .chars()
        .take_while(|character| {
            let next = units + character.len_utf16();
            if next > 32_000 {
                false
            } else {
                units = next;
                true
            }
        })
        .map(char::len_utf16)
        .sum()
}

pub(super) fn resolve_response_language(
    configured: Option<&str>,
    environment: Option<&str>,
    persona: &str,
) -> &'static str {
    normalize_language(configured)
        .or_else(|| normalize_language(environment))
        .or_else(|| {
            let line = persona
                .lines()
                .find(|line| line.to_ascii_lowercase().contains("**language:**"))?;
            normalize_language(Some(line.split_once(':')?.1))
        })
        .unwrap_or("en")
}

fn normalize_language(value: Option<&str>) -> Option<&'static str> {
    let value = value?.trim().to_ascii_lowercase();
    if value == "ko"
        || value == "kr"
        || value.contains("korean")
        || value.contains("한국")
        || value.contains("한글")
    {
        Some("ko")
    } else if value == "en" || value.contains("english") || value.contains("영어") {
        Some("en")
    } else {
        None
    }
}
