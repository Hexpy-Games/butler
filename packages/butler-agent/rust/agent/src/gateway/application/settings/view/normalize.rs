use serde_json::{Map, Value, json};

pub(super) fn ui_defaults() -> Value {
    json!({
        "bridge_mode":"local", "gateway_profile":"electron", "server_url":"",
        "default_project_workspace_label":"Project", "language":"en", "timezone":"UTC",
        "model":"openai/gpt-5.5", "reasoning_effort":"xhigh",
        "consolidation_model":"default", "consolidation_reasoning_effort":"xhigh",
        "effective_consolidation_model":"openai/gpt-5.5", "consolidation_uses_butler_model":true,
        "context_window_tokens":258_000, "worker_profiles":[], "max_simultaneous_workers":10,
        "access_mode":"full_access", "plan_mode_default":false, "follow_up_behavior":"queue",
        "multiline_send_behavior":"modifier_enter_send_enter_newline", "appearance_theme":"system",
        "main_screen_theme":"bloom", "main_screen_theme_preset":"monochrome",
        "main_screen_theme_custom_colors":["#32424d","#555d7c","#485c70","#6a7d9a","#53708d","#434d70"],
        "translucent_sidebar":true, "smart_grouping_enabled":true, "diagnostics_enabled":false,
        "desktop_notifications":{"enabled":true,"assistant_messages":true,"task_completions":true},
        "desktop_tray_enabled":true,
        "web_search":{"provider":"duckduckgo-html","reader_backend":"lightweight","api_key_configured":false,"api_key_env_var":null,"planning_enabled":true,"planning_default_depth":"balanced"},
        "model_fallback":{"enabled":false,"models":[]}, "profile_label":"Local Butler"
    })
}

pub(super) fn native_value<'a>(native: &'a Map<String, Value>, key: &str) -> &'a Value {
    static NULL: Value = Value::Null;
    native.get(key).unwrap_or(&NULL)
}
pub(super) fn object(value: &Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}
pub(super) fn integer(value: &Value) -> Option<u64> {
    let number = value.as_f64()?;
    (number.is_finite() && number.fract() == 0.0 && number >= 0.0)
        .then_some(crate::json::saturating_u64(number))
}
pub(super) fn enum_value(value: Option<&Value>, allowed: &[&str], fallback: &str) -> String {
    value
        .and_then(Value::as_str)
        .filter(|value| allowed.contains(value))
        .unwrap_or(fallback)
        .to_owned()
}
pub(super) fn language(stored: Option<&Value>, configured: Option<&Value>) -> &'static str {
    [stored, configured]
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .find(|value| matches!(*value, "en" | "ko"))
        .map(|value| if value == "ko" { "ko" } else { "en" })
        .unwrap_or("en")
}
pub(super) fn timezone(stored: Option<&Value>, local: Option<&Value>) -> String {
    stored
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| local.and_then(Value::as_str))
        .unwrap_or("UTC")
        .to_owned()
}
pub(super) fn workspace_label(path: &std::path::Path) -> String {
    path.file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("Project")
        .to_owned()
}
pub(super) fn access(value: Option<&Value>) -> &'static str {
    match value.and_then(Value::as_str) {
        Some("ask_first") => "ask_first",
        Some("read_only") => "read_only",
        _ => "full_access",
    }
}
pub(super) fn multiline(value: Option<&Value>) -> &'static str {
    match value.and_then(Value::as_str) {
        Some("enter_send_shift_enter_newline") => "enter_send_shift_enter_newline",
        _ => "modifier_enter_send_enter_newline",
    }
}
pub(super) fn main_theme(value: Option<&Value>) -> &'static str {
    match value.and_then(Value::as_str) {
        Some("none") => "none",
        Some("silk" | "curtain") => "silk",
        _ => "bloom",
    }
}
pub(super) fn main_preset(value: Option<&Value>, colors: &[String; 6]) -> &'static str {
    match value.and_then(Value::as_str) {
        Some("aurora") => "aurora",
        Some("bloom") => "bloom",
        Some("lavender") => "lavender",
        Some("morning") => "morning",
        Some("custom") if !is_default_colors(colors) => "custom",
        Some("custom" | "monochrome") => "monochrome",
        _ => "monochrome",
    }
}
pub(super) fn main_colors(value: Option<&Value>) -> [String; 6] {
    let Some(values) = value
        .and_then(Value::as_array)
        .filter(|values| values.len() == 6)
    else {
        return default_colors();
    };
    let parsed = values
        .iter()
        .map(|value| {
            value
                .as_str()
                .filter(|text| valid_color(text))
                .map(str::to_ascii_lowercase)
        })
        .collect::<Option<Vec<_>>>();
    let Some(values) = parsed else {
        return default_colors();
    };
    std::array::from_fn(|index| values[index].clone())
}
pub(super) fn notifications(value: Option<&Value>) -> Value {
    let value = object(value.unwrap_or(&Value::Null));
    json!({"enabled":value.get("enabled").and_then(Value::as_bool)!=Some(false),"assistant_messages":value.get("assistant_messages").and_then(Value::as_bool)!=Some(false),"task_completions":value.get("task_completions").and_then(Value::as_bool)!=Some(false)})
}

fn valid_color(value: &str) -> bool {
    value.len() == 7
        && value.starts_with('#')
        && value[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
}
fn default_colors() -> [String; 6] {
    std::array::from_fn(|index| DEFAULT_COLOR_VALUES[index].to_owned())
}
fn is_default_colors(colors: &[String; 6]) -> bool {
    colors.iter().map(String::as_str).eq(DEFAULT_COLOR_VALUES)
}
const DEFAULT_COLOR_VALUES: [&str; 6] = [
    "#32424d", "#555d7c", "#485c70", "#6a7d9a", "#53708d", "#434d70",
];
