use std::collections::HashSet;

use serde_json::{Map, Value, json};

use super::model;
use crate::{
    btcc::ReasoningEffort, gateway::application::AppSettingsFacts, public_text::trim_js_whitespace,
};

const DEFAULT_ID: &str = "default";
const MAX_PROFILES: usize = 12;
const DEFAULT_MAX_WORKERS: u64 = 10;

pub(super) fn canonicalize(
    stored: &mut Map<String, Value>,
    facts: &AppSettingsFacts,
    primary_model: &str,
    primary_reasoning: &ReasoningEffort,
) -> bool {
    let has_profiles = stored.contains_key("worker_profiles");
    let has_legacy = stored.contains_key("worker_model_rules");
    let profiles = if has_profiles {
        normalize_profiles(
            stored.get("worker_profiles"),
            facts,
            primary_model,
            primary_reasoning,
        )
    } else {
        migrate_legacy(
            stored.get("worker_model_rules"),
            facts,
            primary_model,
            primary_reasoning,
        )
        .unwrap_or_else(|| vec![default_profile(primary_model, primary_reasoning)])
    };
    let max_workers = stored
        .get("max_simultaneous_workers")
        .and_then(|value| value.as_f64())
        .filter(|value| value.fract() == 0.0 && (1.0..=10.0).contains(value))
        .map(|value| value as u64)
        .unwrap_or(DEFAULT_MAX_WORKERS);
    let profiles_value = Value::Array(profiles);
    let changed = has_legacy
        || !has_profiles
        || stored
            .get("max_simultaneous_workers")
            .and_then(Value::as_f64)
            != Some(max_workers as f64)
        || stored
            .get("worker_profiles")
            .is_none_or(|value| encoded(value) != encoded(&profiles_value));
    if changed {
        stored.shift_remove("worker_model_rules");
        stored.insert("worker_profiles".into(), profiles_value);
        stored.insert("max_simultaneous_workers".into(), max_workers.into());
    }
    changed
}

fn normalize_profiles(
    input: Option<&Value>,
    facts: &AppSettingsFacts,
    primary_model: &str,
    primary_reasoning: &ReasoningEffort,
) -> Vec<Value> {
    let raw = input.and_then(Value::as_array).cloned().unwrap_or_default();
    let mut reserved = HashSet::from([DEFAULT_ID.to_owned()]);
    for entry in &raw {
        if let Some(id) = entry
            .get("id")
            .and_then(Value::as_str)
            .map(trim_js_whitespace)
            && valid_numbered_id(id)
        {
            reserved.insert(id.to_owned());
        }
    }
    let mut seen = HashSet::new();
    let mut profiles = raw
        .iter()
        .filter_map(Value::as_object)
        .take(MAX_PROFILES)
        .map(|entry| {
            let requested = entry
                .get("id")
                .and_then(Value::as_str)
                .map(trim_js_whitespace)
                .unwrap_or("");
            let id = if valid_id(requested) && !seen.contains(requested) {
                requested.to_owned()
            } else {
                next_id(&reserved, &seen)
            };
            seen.insert(id.clone());
            stored_profile(entry, id, facts, primary_model, primary_reasoning)
        })
        .collect::<Vec<_>>();
    ensure_default(&mut profiles, primary_model, primary_reasoning);
    profiles
}

fn migrate_legacy(
    input: Option<&Value>,
    facts: &AppSettingsFacts,
    primary_model: &str,
    primary_reasoning: &ReasoningEffort,
) -> Option<Vec<Value>> {
    let entries = input?
        .as_array()?
        .iter()
        .filter_map(Value::as_object)
        .take(MAX_PROFILES)
        .collect::<Vec<_>>();
    if entries.is_empty() {
        return None;
    }
    let mut seen = HashSet::from([DEFAULT_ID.to_owned()]);
    let mut profiles = Vec::new();
    for (index, entry) in entries.into_iter().enumerate() {
        let id = if index == 0 {
            DEFAULT_ID.to_owned()
        } else {
            let value = next_id(&HashSet::new(), &seen);
            seen.insert(value.clone());
            value
        };
        let condition = collapsed(entry.get("condition").and_then(Value::as_str).unwrap_or(""));
        let job = if condition.is_empty() {
            json!({"kind":"builtin","job":"coding"})
        } else {
            json!({"kind":"custom","text":truncate_utf16(&condition,160)})
        };
        let (model, reasoning) = model_fields(entry, facts, primary_model, primary_reasoning);
        profiles.push(json!({
            "id":id,
            "label":safe_text(
                entry.get("label"),
                &if index==0{"Default".into()}else{format!("Worker {}",index+1)},
                64,
            ),
            "enabled":if index==0{true}else{entry.get("enabled").and_then(Value::as_bool)!=Some(false)},
            "job":job,
            "model":model,
            "reasoning_effort":reasoning,
        }));
    }
    ensure_default(&mut profiles, primary_model, primary_reasoning);
    Some(profiles)
}

fn stored_profile(
    entry: &Map<String, Value>,
    id: String,
    facts: &AppSettingsFacts,
    primary_model: &str,
    primary_reasoning: &ReasoningEffort,
) -> Value {
    let (model, reasoning) = model_fields(entry, facts, primary_model, primary_reasoning);
    let mut output = Map::new();
    output.insert("id".into(), id.into());
    output.insert(
        "label".into(),
        safe_text(entry.get("label"), "Worker profile", 64).into(),
    );
    output.insert(
        "enabled".into(),
        (entry.get("enabled").and_then(Value::as_bool) != Some(false)).into(),
    );
    output.insert("job".into(), valid_job(entry.get("job")));
    if let Some(domain) = bounded(entry.get("domain"), 96) {
        output.insert("domain".into(), domain.into());
    }
    output.insert("model".into(), model.into());
    output.insert("reasoning_effort".into(), json!(reasoning));
    if let Some(prompt) = entry.get("prompt").and_then(Value::as_str)
        && prompt.encode_utf16().count() <= 2_000
    {
        output.insert("prompt".into(), prompt.into());
    }
    Value::Object(output)
}

fn model_fields(
    entry: &Map<String, Value>,
    facts: &AppSettingsFacts,
    primary_model: &str,
    primary_reasoning: &ReasoningEffort,
) -> (String, ReasoningEffort) {
    let requested = entry
        .get("model")
        .and_then(Value::as_str)
        .map(trim_js_whitespace)
        .unwrap_or("");
    let matched =
        model::find_unique(requested, &facts.known_models).filter(|value| value.runtime_supported);
    let Some(metadata) = matched else {
        return (primary_model.to_owned(), primary_reasoning.clone());
    };
    let requested_reasoning = entry
        .get("reasoning_effort")
        .and_then(Value::as_str)
        .and_then(model::parse_reasoning)
        .filter(|value| metadata.reasoning_efforts.contains(value));
    let reasoning = requested_reasoning.unwrap_or_else(|| {
        if metadata.reasoning_efforts.contains(primary_reasoning) {
            primary_reasoning.clone()
        } else {
            metadata.default_reasoning_effort.clone()
        }
    });
    (metadata.model_ref.clone(), reasoning)
}

fn ensure_default(values: &mut Vec<Value>, model: &str, reasoning: &ReasoningEffort) {
    if let Some(index) = values
        .iter()
        .position(|value| value.get("id").and_then(Value::as_str) == Some(DEFAULT_ID))
    {
        values[index]["enabled"] = Value::Bool(true);
        let default = values.remove(index);
        values.insert(0, default);
    } else {
        values.insert(0, default_profile(model, reasoning));
    }
    values.truncate(MAX_PROFILES);
}

fn default_profile(model: &str, reasoning: &ReasoningEffort) -> Value {
    json!({"id":"default","label":"Default","enabled":true,
        "job":{"kind":"builtin","job":"coding"},"model":model,"reasoning_effort":reasoning})
}

fn valid_job(input: Option<&Value>) -> Value {
    let Some(job) = input.and_then(Value::as_object) else {
        return json!({"kind":"builtin","job":"coding"});
    };
    if job.len() == 2 && job.get("kind").and_then(Value::as_str) == Some("builtin") {
        let name = job.get("job").and_then(Value::as_str);
        if matches!(
            name,
            Some("coding" | "research" | "debug" | "review" | "writing")
        ) {
            return Value::Object(job.clone());
        }
    }
    if job.len() == 2
        && job.get("kind").and_then(Value::as_str) == Some("custom")
        && bounded(job.get("text"), 160).is_some()
    {
        return Value::Object(job.clone());
    }
    json!({"kind":"builtin","job":"coding"})
}

fn safe_text(input: Option<&Value>, fallback: &str, max: usize) -> String {
    let value = collapsed(input.and_then(Value::as_str).unwrap_or(""));
    if value.is_empty() {
        fallback.into()
    } else if value.encode_utf16().count() > max {
        truncate_utf16(&value, max.saturating_sub(1))
            .trim_end()
            .into()
    } else {
        value
    }
}
fn bounded(input: Option<&Value>, max: usize) -> Option<String> {
    let source = input?.as_str()?;
    let normalized = collapsed(source);
    (!normalized.is_empty() && normalized.encode_utf16().count() <= max).then(|| source.to_owned())
}
fn collapsed(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}
fn truncate_utf16(value: &str, max: usize) -> String {
    value
        .chars()
        .scan(0, |used, ch| {
            *used += ch.len_utf16();
            Some((*used <= max).then_some(ch))
        })
        .flatten()
        .collect()
}
fn valid_id(value: &str) -> bool {
    value == DEFAULT_ID || valid_numbered_id(value)
}
fn valid_numbered_id(value: &str) -> bool {
    value.strip_prefix('w').is_some_and(|tail| {
        !tail.is_empty() && !tail.starts_with('0') && tail.bytes().all(|byte| byte.is_ascii_digit())
    })
}
fn next_id(reserved: &HashSet<String>, seen: &HashSet<String>) -> String {
    (1_u64..)
        .map(|number| format!("w{number}"))
        .find(|id| !reserved.contains(id) && !seen.contains(id))
        .expect("unbounded profile id space")
}
fn encoded(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_default()
}
