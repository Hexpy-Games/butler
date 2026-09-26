use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value};

use super::super::contracts::{ProfileError, ProfileResult, ProfilingMode};
use super::types::{CorrectionTarget, ExtractedCandidate};
use values::{valid_category, valid_facet};

mod values;

pub(super) fn strict(
    raw: &str,
    allowed: &HashSet<String>,
    mode: ProfilingMode,
    targets: &HashMap<String, CorrectionTarget>,
) -> ProfileResult<Vec<ExtractedCandidate>> {
    let payload = strict_object(raw)?;
    let items = payload
        .get("candidates")
        .and_then(Value::as_array)
        .ok_or_else(|| validation("profile extractor response missing candidates"))?;
    let mut output = Vec::new();
    for item in items {
        let object = item
            .as_object()
            .ok_or_else(|| validation("profile extractor candidate has invalid shape"))?;
        let raw_refs = object
            .get("evidence_refs")
            .and_then(Value::as_array)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| validation("profile extractor candidate has invalid evidence refs"))?;
        if raw_refs.iter().any(|value| {
            value
                .as_str()
                .map(crate::public_text::trim_js_whitespace)
                .is_none_or(|value| !allowed.contains(value))
        }) {
            return Err(validation(
                "profile extractor candidate has invalid evidence refs",
            ));
        }
        let mut candidate = normalize(object, allowed, mode)
            .ok_or_else(|| validation("profile extractor candidate failed validation"))?;
        if candidate.evidence_refs.is_empty() {
            return Err(validation("profile extractor candidate failed validation"));
        }
        if object
            .get("contradiction_refs")
            .is_some_and(|value| !value.is_array())
        {
            return Err(validation(
                "profile extractor correction refs have invalid shape",
            ));
        }
        let raw_corrections = object
            .get("contradiction_refs")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if raw_corrections.iter().any(|value| {
            value
                .as_str()
                .map(crate::public_text::trim_js_whitespace)
                .is_none_or(str::is_empty)
        }) {
            return Err(validation(
                "profile extractor correction refs have invalid shape",
            ));
        }
        let requested = unique(
            raw_corrections
                .iter()
                .filter_map(Value::as_str)
                .map(|value| crate::public_text::trim_js_whitespace(value).to_owned())
                .collect(),
            usize::MAX,
        );
        let mut resolved = Vec::new();
        for reference in requested {
            let target = targets.get(&reference).ok_or_else(|| {
                validation("profile extractor correction target failed validation")
            })?;
            let facet = candidate.payload.get("facet").and_then(Value::as_str);
            let conditions = strings(&candidate.payload, "applies_when", 6);
            if candidate.source_type != "explicit"
                || candidate.category != target.category
                || facet != target.facet.as_deref()
                || normalized_conditions(conditions) != target.applies_when
            {
                return Err(validation(
                    "profile extractor correction target failed validation",
                ));
            }
            resolved.push(Value::String(target.stable_id.clone()));
        }
        resolved.truncate(6);
        candidate
            .payload
            .as_object_mut()
            .unwrap()
            .insert("contradiction_refs".into(), Value::Array(resolved));
        output.push(candidate);
    }
    Ok(output)
}

pub(super) fn forgiving(
    raw: &str,
    allowed: &HashSet<String>,
    mode: ProfilingMode,
) -> Vec<ExtractedCandidate> {
    let payload = forgiving_object(raw);
    payload
        .get("candidates")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .filter_map(|item| normalize(item, allowed, mode))
        .take(40)
        .collect()
}

fn normalize(
    object: &Map<String, Value>,
    allowed: &HashSet<String>,
    mode: ProfilingMode,
) -> Option<ExtractedCandidate> {
    let category = valid_category(object.get("category")?.as_str()?)?;
    if mode == ProfilingMode::Off
        || mode == ProfilingMode::Basic
            && !matches!(category, "communication" | "epistemic_style" | "boundaries")
    {
        return None;
    }
    let summary = normalize_text(object.get("summary")?.as_str()?, 320);
    if summary.is_empty() {
        return None;
    }
    let facet = valid_facet(object.get("facet").and_then(Value::as_str));
    let declared = object.get("sensitive_domain").and_then(Value::as_bool) == Some(true);
    let sensitive = normalize_sensitive(category, facet, declared);
    let evidence_refs = unique(
        object
            .get("evidence_refs")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(crate::public_text::trim_js_whitespace)
            .filter(|value| allowed.contains(*value))
            .map(str::to_owned)
            .collect(),
        12,
    );
    let source = match object.get("source_type").and_then(Value::as_str) {
        Some("explicit") => "explicit",
        Some("repeated_observation") => "repeated_observation",
        Some("user_confirmed") => "user_confirmed",
        _ => "inference",
    };
    let confidence = match object.get("confidence").and_then(Value::as_str) {
        Some("medium") => "medium",
        Some("high") => "high",
        _ => "low",
    };
    let mut payload = Map::new();
    payload.insert("summary".into(), Value::String(summary));
    payload.insert(
        "facet".into(),
        facet
            .map(|value| Value::String(value.into()))
            .unwrap_or(Value::Null),
    );
    payload.insert(
        "layer".into(),
        valid(
            object,
            "layer",
            &[
                "stable_disposition",
                "contextual_adaptation",
                "current_attention",
                "narrative_meaning",
            ],
        ),
    );
    for key in ["applies_when", "butler_should", "butler_should_not"] {
        payload.insert(key.into(), Value::Array(strings_value(object.get(key), 6)));
    }
    payload.insert(
        "contradiction_refs".into(),
        Value::Array(strings_value(object.get("contradiction_refs"), 6)),
    );
    payload.insert(
        "temporal_scope".into(),
        valid(
            object,
            "temporal_scope",
            &["transient", "active", "durable"],
        ),
    );
    payload.insert(
        "decay_policy".into(),
        valid(
            object,
            "decay_policy",
            &[
                "days_7",
                "days_30",
                "reinforce_or_decay",
                "never_without_consent",
            ],
        ),
    );
    let sensitivity = if sensitive {
        valid(
            object,
            "sensitivity",
            &["normal", "sensitive", "restricted"],
        )
    } else {
        Value::String("normal".into())
    };
    payload.insert("sensitivity".into(), sensitivity);
    Some(ExtractedCandidate {
        payload: Value::Object(payload),
        category: category.into(),
        source_type: source.into(),
        confidence: confidence.into(),
        sensitive_domain: sensitive,
        evidence_refs,
        expires_or_decay: Some(
            match object.get("expires_or_decay").and_then(Value::as_str) {
                Some("expires") => "expires",
                _ => "decay",
            }
            .into(),
        ),
    })
}

fn strict_object(raw: &str) -> ProfileResult<Map<String, Value>> {
    let text = fences(raw);
    let value: Value = serde_json::from_str(text)
        .map_err(|_| validation("profile extractor response is invalid JSON"))?;
    value
        .as_object()
        .cloned()
        .ok_or_else(|| validation("profile extractor response is not an object"))
}

fn forgiving_object(raw: &str) -> Map<String, Value> {
    let text = fences(raw);
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .or_else(|| {
            let start = text.find('{')?;
            let end = text.rfind('}')?;
            (end > start)
                .then(|| &text[start..=end])
                .and_then(|slice| serde_json::from_str::<Value>(slice).ok())
                .and_then(|value| value.as_object().cloned())
        })
        .unwrap_or_default()
}

fn fences(raw: &str) -> &str {
    let mut text = crate::public_text::trim_js_whitespace(raw);
    if text
        .get(..7)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("```json"))
    {
        text = &text[7..]
    } else if text.starts_with("```") {
        text = &text[3..]
    }
    text = crate::public_text::trim_js_whitespace(text);
    if let Some(value) = text.strip_suffix("```") {
        text = crate::public_text::trim_js_whitespace(value)
    }
    text
}

fn normalize_sensitive(category: &str, facet: Option<&str>, declared: bool) -> bool {
    declared
        && !matches!(facet, Some("privacy_rules" | "consent_required"))
        && !matches!(category, "communication" | "epistemic_style" | "aesthetics")
        && !matches!(
            facet,
            Some(
                "roles"
                    | "self_descriptions"
                    | "current_interests"
                    | "enduring_interests"
                    | "meaningful_objects"
                    | "active_projects"
                    | "collaboration_preferences"
                    | "quality_sense"
                    | "tone_preference"
                    | "explanation_preference"
                    | "emotional_mode"
                    | "how_the_user_thinks"
                    | "evidence_preference"
                    | "correction_style"
            )
        )
}
fn normalize_text(value: &str, limit: usize) -> String {
    super::super::naming::bounded(&super::super::naming::collapse_js_whitespace(value), limit)
}
fn strings(value: &Value, key: &str, limit: usize) -> Vec<String> {
    value
        .get(key)
        .map(|value| {
            strings_value(Some(value), limit)
                .into_iter()
                .filter_map(|value| value.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}
fn strings_value(value: Option<&Value>, limit: usize) -> Vec<Value> {
    unique(
        value
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(|value| normalize_text(value, 240))
            .filter(|value| !value.is_empty())
            .collect(),
        limit,
    )
    .into_iter()
    .map(Value::String)
    .collect()
}
fn unique(values: Vec<String>, limit: usize) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter(|value| seen.insert(value.clone()))
        .take(limit)
        .collect()
}
fn valid(object: &Map<String, Value>, key: &str, allowed: &[&str]) -> Value {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| allowed.contains(value))
        .map(|value| Value::String(value.into()))
        .unwrap_or(Value::Null)
}
fn normalized_conditions(mut value: Vec<String>) -> Vec<String> {
    value = value
        .into_iter()
        .map(|value| crate::public_text::trim_js_whitespace(&value).to_owned())
        .filter(|value| !value.is_empty())
        .collect();
    value.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    value.dedup();
    value
}
fn validation(message: &str) -> ProfileError {
    ProfileError::new("profile_extractor_invalid", message)
}

#[cfg(test)]
mod tests;
