use std::fs;
use std::path::Path;

use serde_json::{Map, Value};

use super::contracts::{ProfileResult, ProfilingExtractorModelSnapshot};
use super::naming;

const DEFAULT_SETTING: &str = "default";

pub(crate) fn read(data_root: &Path) -> ProfilingExtractorModelSnapshot {
    let config = read_config(data_root);
    let configured = config
        .pointer("/personalization/profiling/extractorModel")
        .and_then(Value::as_str)
        .and_then(normalize_model);
    let configured = configured.filter(|value| value != DEFAULT_SETTING);
    let butler_model = config.pointer("/system/butlerModel");
    let fallback = match butler_model {
        None | Some(Value::Null) => config.pointer("/system/defaultModel"),
        value => value,
    }
    .and_then(Value::as_str)
    .and_then(valid_model)
    .unwrap_or_else(|| crate::models::DEFAULT_MODEL_REF.to_owned());
    let reasoning = config
        .pointer("/personalization/profiling/extractorReasoningEffort")
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "none" | "low" | "medium" | "high" | "xhigh" | "max"))
        .unwrap_or("xhigh")
        .to_owned();
    ProfilingExtractorModelSnapshot {
        effective_model: configured.clone().unwrap_or(fallback),
        uses_butler_model: configured.is_none(),
        configured_model: configured,
        reasoning_effort: reasoning,
    }
}

pub(super) fn set_model(
    data_root: &Path,
    model: Option<&str>,
    pid: u32,
    now_ms: i64,
) -> ProfileResult<ProfilingExtractorModelSnapshot> {
    mutate(data_root, pid, now_ms, |profile| {
        profile.insert(
            "extractorModel".into(),
            Value::String(
                normalize_model(model.unwrap_or(DEFAULT_SETTING))
                    .unwrap_or_else(|| DEFAULT_SETTING.into()),
            ),
        );
    })?;
    Ok(read(data_root))
}

pub(super) fn set_reasoning(
    data_root: &Path,
    effort: Option<&str>,
    pid: u32,
    now_ms: i64,
) -> ProfileResult<ProfilingExtractorModelSnapshot> {
    mutate(data_root, pid, now_ms, |profile| {
        let value = effort
            .filter(|value| matches!(*value, "none" | "low" | "medium" | "high" | "xhigh" | "max"))
            .unwrap_or("xhigh");
        profile.insert(
            "extractorReasoningEffort".into(),
            Value::String(value.into()),
        );
    })?;
    Ok(read(data_root))
}

fn mutate(
    data_root: &Path,
    pid: u32,
    now_ms: i64,
    change: impl FnOnce(&mut Map<String, Value>),
) -> ProfileResult<()> {
    let mut config = read_config(data_root);
    let root = crate::json::object_mut(&mut config);
    let personalization = object(root, "personalization");
    let profile = object(personalization, "profiling");
    change(profile);
    naming::atomic_json(&data_root.join("butler.config.json"), &config, pid, now_ms)
}

fn read_config(data_root: &Path) -> Value {
    fs::read(data_root.join("butler.config.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| Value::Object(Map::new()))
}
fn object<'a>(map: &'a mut Map<String, Value>, key: &str) -> &'a mut Map<String, Value> {
    crate::json::object_field_mut(map, key)
}
fn normalize_model(value: &str) -> Option<String> {
    let value = crate::public_text::trim_js_whitespace(value);
    if value.is_empty() || matches!(value, "default" | "butler") {
        return Some(DEFAULT_SETTING.into());
    }
    valid_model(value).or_else(|| Some(DEFAULT_SETTING.into()))
}
fn valid_model(value: &str) -> Option<String> {
    let parsed = crate::models::parse_model_ref(value);
    (!parsed.model_id.is_empty()).then_some(parsed.canonical_ref)
}
