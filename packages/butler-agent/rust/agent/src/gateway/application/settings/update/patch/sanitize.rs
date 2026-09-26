use serde_json::{Map, Value, json};

use super::super::super::{AppSettingsFacts, validation};
use crate::public_text::trim_js_whitespace;

pub(super) fn sanitize(input: &Value, facts: &AppSettingsFacts) -> Value {
    let Some(input) = input.as_object() else {
        return Value::Object(Map::new());
    };
    let mut output = Map::new();
    if let Some(value) = input.get("server_url").and_then(Value::as_str) {
        let value = value.trim();
        if valid_server_url(value) {
            output.insert("server_url".into(), json!(value));
        }
    }
    if let Some(value @ ("en" | "ko")) = input.get("language").and_then(Value::as_str) {
        output.insert("language".into(), json!(value));
    }
    if let Some(value) = input.get("timezone").and_then(Value::as_str)
        && validation::is_iana_timezone(&json!(value))
    {
        output.insert("timezone".into(), json!(value.trim()));
    }
    if let Some(value) = input.get("model").and_then(Value::as_str)
        && let Some(value) = super::super::available_model_ref(value, facts)
    {
        output.insert("model".into(), json!(value));
    }
    if let Some(value) = input.get("reasoning_effort").and_then(Value::as_str)
        && reasoning(value).is_some()
    {
        output.insert("reasoning_effort".into(), json!(value));
    }
    if let Some(value) = input.get("consolidation_model").and_then(Value::as_str) {
        let value = trim_js_whitespace(value);
        if value == "default" {
            output.insert("consolidation_model".into(), json!(value));
        } else if let Some(value) = super::super::available_model_ref(value, facts) {
            output.insert("consolidation_model".into(), json!(value));
        }
    }
    if input
        .get("consolidation_reasoning_effort")
        .and_then(Value::as_str)
        .is_some_and(|value| reasoning(value).is_some())
    {
        output.insert(
            "consolidation_reasoning_effort".into(),
            input["consolidation_reasoning_effort"].clone(),
        );
    }
    if let Some(value) = input.get("context_window_tokens").and_then(Value::as_f64)
        && value.is_finite()
        && value > 0.0
    {
        output.insert("context_window_tokens".into(), json!(value.trunc() as u64));
    }
    for key in ["worker_profiles", "desktop_notifications", "web_search"] {
        if let Some(value) = input.get(key) {
            match key {
                "worker_profiles" => {
                    if value.is_array() {
                        output.insert(key.into(), value.clone());
                    }
                }
                "desktop_notifications" => {
                    if let Some(value) = value.as_object() {
                        output.insert(key.into(), Value::Object(value.clone()));
                    }
                }
                "web_search" => {
                    let mut patch = Map::new();
                    if let Some(value) = value.as_object() {
                        for (key, value) in value {
                            match key.as_str() {
                                "provider" if valid_web_provider(value) => {
                                    patch.insert(key.clone(), value.clone());
                                }
                                "reader_backend" if valid_reader_backend(value) => {
                                    patch.insert(key.clone(), value.clone());
                                }
                                "api_key" => {
                                    if let Some(value) = value.as_str().map(str::trim)
                                        && !value.is_empty()
                                    {
                                        patch.insert(key.clone(), json!(value));
                                    }
                                }
                                "planning_enabled" if value.is_boolean() => {
                                    patch.insert(key.clone(), value.clone());
                                }
                                "planning_default_depth" if valid_depth(value) => {
                                    patch.insert(key.clone(), value.clone());
                                }
                                _ => {}
                            }
                        }
                    }
                    if !patch.is_empty() {
                        output.insert(key.into(), Value::Object(patch));
                    }
                }
                _ => unreachable!(),
            }
        }
    }
    if let Some(value) = input
        .get("max_simultaneous_workers")
        .and_then(Value::as_f64)
        && value.is_finite()
        && value.fract() == 0.0
        && (1.0..=10.0).contains(&value)
    {
        output.insert("max_simultaneous_workers".into(), json!(value as u64));
    }
    if input
        .get("access_mode")
        .and_then(Value::as_str)
        .is_some_and(|value| matches!(value, "full_access" | "ask_first" | "read_only"))
    {
        output.insert("access_mode".into(), input["access_mode"].clone());
    }
    for (key, allowed) in [
        ("follow_up_behavior", &["queue", "steer"][..]),
        (
            "multiline_send_behavior",
            &[
                "modifier_enter_send_enter_newline",
                "enter_send_shift_enter_newline",
                "enter_newline_shift_enter_send",
            ][..],
        ),
        ("appearance_theme", &["system", "light", "dark"][..]),
        (
            "main_screen_theme_preset",
            &[
                "monochrome",
                "aurora",
                "bloom",
                "lavender",
                "morning",
                "custom",
            ][..],
        ),
    ] {
        if let Some(value) = input
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| allowed.contains(value))
        {
            let normalized =
                if key == "multiline_send_behavior" && value == "enter_newline_shift_enter_send" {
                    "modifier_enter_send_enter_newline"
                } else {
                    value
                };
            output.insert(key.into(), json!(normalized));
        }
    }
    for key in [
        "plan_mode_default",
        "translucent_sidebar",
        "diagnostics_enabled",
    ] {
        if let Some(value) = input.get(key).filter(|value| value.is_boolean()) {
            output.insert(key.into(), value.clone());
        }
    }
    if let Some(value) = input
        .get("smart_grouping_enabled")
        .filter(|value| value.is_boolean())
    {
        output.insert("smart_grouping_enabled".into(), value.clone());
    }
    if let Some(value) = input
        .get("desktop_tray_enabled")
        .filter(|value| value.is_boolean())
    {
        output.insert("desktop_tray_enabled".into(), value.clone());
    }
    if let Some(value) = input.get("main_screen_theme").and_then(Value::as_str) {
        let normalized = match value {
            "curtain" => Some("silk"),
            "none" | "bloom" | "silk" => Some(value),
            _ => None,
        };
        if let Some(normalized) = normalized {
            output.insert("main_screen_theme".into(), json!(normalized));
        }
    }
    if let Some(value) = input.get("main_screen_theme_custom_colors")
        && let Some(colors) = colors(value)
    {
        output.insert("main_screen_theme_custom_colors".into(), json!(colors));
    }
    if let Some(value) = input.get("model_fallback").and_then(Value::as_object) {
        let mut fallback = Map::new();
        if let Some(value) = value.get("enabled").filter(|value| value.is_boolean()) {
            fallback.insert("enabled".into(), value.clone());
        }
        if let Some(value) = value.get("models").and_then(Value::as_array) {
            fallback.insert(
                "models".into(),
                Value::Array(
                    value
                        .iter()
                        .filter(|item| item.is_string())
                        .cloned()
                        .collect(),
                ),
            );
        }
        output.insert("model_fallback".into(), Value::Object(fallback));
    }
    Value::Object(output)
}

fn valid_server_url(value: &str) -> bool {
    ["http://", "https://"].iter().any(|prefix| {
        value
            .strip_prefix(prefix)
            .is_some_and(|suffix| !suffix.is_empty() && !suffix.chars().any(char::is_whitespace))
    })
}

fn valid_web_provider(value: &Value) -> bool {
    matches!(
        value.as_str(),
        Some(
            "duckduckgo-html"
                | "auto"
                | "brave"
                | "tavily"
                | "openai-web-search"
                | "codex-subscription-web-search"
                | "disabled"
        )
    )
}

fn valid_reader_backend(value: &Value) -> bool {
    matches!(
        value.as_str(),
        Some("lightweight" | "auto" | "lightpanda" | "jina-hosted" | "disabled")
    )
}

fn valid_depth(value: &Value) -> bool {
    matches!(value.as_str(), Some("quick" | "balanced" | "deep"))
}

fn colors(value: &Value) -> Option<[String; 6]> {
    let colors = value.as_array()?.iter().map(|value| {
        let color = value.as_str()?.trim();
        (color.len() == 7
            && color.starts_with('#')
            && color[1..].bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then(|| color.to_ascii_lowercase())
    });
    let colors = colors.collect::<Option<Vec<_>>>()?;
    colors.try_into().ok()
}

fn reasoning(value: &str) -> Option<crate::btcc::ReasoningEffort> {
    super::super::model::parse_reasoning(value)
}
