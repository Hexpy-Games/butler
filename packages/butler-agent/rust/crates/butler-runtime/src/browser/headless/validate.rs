//! Step validation before anything resolves (the App executor's `stepError`).
use super::{input, steps::NAVIGATION};
use serde_json::Value;

pub(crate) const POINTER: [&str; 7] = [
    "click", "fill", "select", "scroll", "hover", "drag", "upload",
];
pub(crate) const STEP_HELP: &str = "Pointer steps (click, fill, select, scroll, hover, drag) use exactly one of ref or point, never both; fill/select require ref. upload clicks the page's upload control (ref or point) with value = the workspace file. back, forward and reload take no target and end the batch. press, type and wait take no target: press sends one key or chord (\"Enter\", \"Escape\", \"Control+Z\") to the focused element, type inserts text at the focus, wait pauses 50–5000 ms. button and click_count apply to click; modifiers to click, drag and scroll; path only to a point drag. No steps were dispatched.";

pub(crate) fn present(value: &Value) -> bool {
    !value.is_null() && value != false && value != "" && value != 0
}

pub(crate) fn step_error(step: &Value) -> Option<&'static str> {
    let action = step["action"].as_str().unwrap_or("");
    let known = POINTER.contains(&action)
        || matches!(action, "press" | "type" | "wait")
        || NAVIGATION.contains(&action);
    if !known {
        return Some("invalid_step");
    }
    let (has_ref, has_point) = (present(&step["ref"]), present(&step["point"]));
    if POINTER.contains(&action) {
        if has_ref == has_point
            || has_point && !matches!(action, "click" | "scroll" | "hover" | "drag" | "upload")
        {
            return Some("invalid_step");
        }
    } else if has_ref || has_point || present(&step["target_ref"]) || present(&step["target_point"])
    {
        return Some("invalid_step");
    }
    if action == "press" && input::parse_chord(&step["value"]).is_none() {
        return Some("invalid_key");
    }
    if action == "type"
        && step["value"]
            .as_str()
            .is_none_or(|v| v.is_empty() || v.encode_utf16().count() > 2000)
    {
        return Some("invalid_step");
    }
    if action == "upload"
        && step["value"]
            .as_str()
            .is_none_or(|v| !v.starts_with('/') && !windows_absolute(v))
    {
        return Some("invalid_step");
    }
    if action == "wait"
        && !wait_value(&step["value"]).is_some_and(|ms| (50.0..=5000.0).contains(&ms))
    {
        return Some("invalid_step");
    }
    let defined = |key: &str| step.get(key).is_some_and(|v| !v.is_null());
    if defined("button")
        && (action != "click"
            || !matches!(step["button"].as_str(), Some("left" | "right" | "middle")))
    {
        return Some("invalid_step");
    }
    if defined("click_count")
        && (action != "click"
            || !matches!(step["click_count"].as_u64(), Some(1..=3))
            || step["click_count"].is_f64())
    {
        return Some("invalid_step");
    }
    if defined("modifiers")
        && (!matches!(action, "click" | "drag" | "scroll")
            || step["modifiers"].as_array().is_none_or(|m| {
                m.iter()
                    .any(|n| !matches!(n.as_str(), Some("Shift" | "Control" | "Alt" | "Meta")))
            }))
    {
        return Some("invalid_step");
    }
    if defined("path")
        && (action != "drag"
            || !has_point
            || !present(&step["target_point"])
            || !valid_path(&step["path"]))
    {
        return Some("invalid_step");
    }
    None
}

fn windows_absolute(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/')
}

pub(crate) fn wait_value(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

fn valid_path(path: &Value) -> bool {
    path.as_array().is_some_and(|points| {
        points.len() <= 24
            && points.iter().all(|p| {
                p.as_array().is_some_and(|xy| {
                    xy.len() == 2 && xy.iter().all(|v| v.as_f64().is_some_and(f64::is_finite))
                })
            })
    })
}
