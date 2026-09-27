use std::collections::HashSet;

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use super::super::contracts::ProfilingMode;
pub(super) fn defaults(payload: &mut Map<String, Value>, category: &str, sensitive: bool) {
    let facet = payload
        .get("facet")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let facet = facet.as_deref();
    let summary = payload
        .get("summary")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let layer =
        if category == "cares" || matches!(facet, Some("current_interests" | "active_projects")) {
            "current_attention"
        } else if category == "narrative"
            || matches!(
                facet,
                Some(
                    "meaningful_events"
                        | "turning_points"
                        | "unresolved_threads"
                        | "self_descriptions"
                        | "commitments"
                )
            )
        {
            "narrative_meaning"
        } else if category == "communication"
            || category == "epistemic_style"
            || category == "boundaries"
            || matches!(
                facet,
                Some("collaboration_preferences" | "correction_style" | "evidence_preference")
            )
        {
            "contextual_adaptation"
        } else {
            "stable_disposition"
        };
    payload
        .entry("layer")
        .or_insert(Value::String(layer.into()));
    payload
        .entry("applies_when")
        .or_insert_with(|| string_array(infer_applies_when(category, facet)));
    payload
        .entry("butler_should")
        .or_insert_with(|| string_array(infer_should(category, facet, &summary)));
    payload
        .entry("butler_should_not")
        .or_insert_with(|| string_array(infer_should_not(category, facet)));
    payload
        .entry("contradiction_refs")
        .or_insert(Value::Array(Vec::new()));
    payload.entry("temporal_scope").or_insert(Value::String(
        if layer == "stable_disposition" || layer == "narrative_meaning" {
            "durable"
        } else {
            "active"
        }
        .into(),
    ));
    payload.entry("decay_policy").or_insert(Value::String(
        if layer == "current_attention" {
            "days_30"
        } else if sensitive {
            "never_without_consent"
        } else {
            "reinforce_or_decay"
        }
        .into(),
    ));
    payload.entry("sensitivity").or_insert(Value::String(
        if sensitive { "sensitive" } else { "normal" }.into(),
    ));
}

fn string_array(values: Vec<&str>) -> Value {
    Value::Array(
        values
            .into_iter()
            .map(|value| Value::String(value.into()))
            .collect(),
    )
}

fn infer_applies_when<'a>(category: &str, facet: Option<&str>) -> Vec<&'a str> {
    match (category, facet) {
        ("communication", _) => vec!["answering"],
        ("epistemic_style", _) => vec!["analysis", "recommendation", "implementation_report"],
        ("boundaries", _) => vec!["all_interactions"],
        (_, Some("current_interests")) => vec!["topic_relevance"],
        (_, Some("active_projects")) => vec!["project_work"],
        ("aesthetics", _) => vec!["design_review", "product_recommendation"],
        _ => Vec::new(),
    }
}

fn infer_should<'a>(category: &str, facet: Option<&str>, summary: &'a str) -> Vec<&'a str> {
    match (category, facet) {
        ("communication" | "epistemic_style", _) => vec![summary],
        ("boundaries", _) => vec!["respect this boundary before optimizing for convenience"],
        (_, Some("current_interests")) => vec!["use this as current context only when relevant"],
        (_, Some("active_projects")) => vec!["prioritize this context in related project work"],
        ("aesthetics", _) => vec!["reflect this quality bar in visual or product judgments"],
        _ => Vec::new(),
    }
}

fn infer_should_not<'a>(category: &str, facet: Option<&str>) -> Vec<&'a str> {
    match (category, facet) {
        ("boundaries", _) => vec!["expose private internals without explicit request"],
        ("epistemic_style", _) => vec!["claim completion without verification"],
        (_, Some("current_interests")) => vec!["overfit unrelated answers to this interest"],
        _ => Vec::new(),
    }
}

pub(super) fn merge_understanding(
    payload: &mut Map<String, Value>,
    previous: Option<&Map<String, Value>>,
    category: &str,
    sensitive: bool,
) {
    let facet = payload.get("facet").and_then(Value::as_str);
    let summary = payload.get("summary").and_then(Value::as_str).unwrap_or("");
    let mut inferred = Map::new();
    inferred.insert("summary".into(), Value::String(summary.to_owned()));
    if let Some(facet) = facet {
        inferred.insert("facet".into(), Value::String(facet.to_owned()));
    }
    defaults(&mut inferred, category, sensitive);

    for (key, allowed) in [
        (
            "layer",
            &[
                "stable_disposition",
                "contextual_adaptation",
                "current_attention",
                "narrative_meaning",
            ][..],
        ),
        ("temporal_scope", &["transient", "active", "durable"]),
        (
            "decay_policy",
            &[
                "days_7",
                "days_30",
                "reinforce_or_decay",
                "never_without_consent",
            ],
        ),
        ("sensitivity", &["normal", "sensitive", "restricted"]),
    ] {
        let selected = valid_scalar(payload.get(key), allowed)
            .or_else(|| previous.and_then(|value| valid_scalar(value.get(key), allowed)))
            .or_else(|| inferred.get(key).and_then(Value::as_str))
            .unwrap_or("");
        payload.insert(key.into(), Value::String(selected.to_owned()));
    }
    if !sensitive {
        payload.insert("sensitivity".into(), Value::String("normal".into()));
    }
    for key in [
        "applies_when",
        "butler_should",
        "butler_should_not",
        "contradiction_refs",
    ] {
        let mut values = previous
            .map(|value| strings(&Value::Object(value.clone()), key))
            .unwrap_or_default();
        values.extend(strings(&Value::Object(payload.clone()), key));
        if key != "contradiction_refs" {
            values.extend(strings(&Value::Object(inferred.clone()), key));
        }
        let values = unique(
            values
                .into_iter()
                .map(|value| normalize_text(&value, 320))
                .filter(|value| !value.is_empty())
                .collect(),
        );
        payload.insert(
            key.into(),
            Value::Array(values.into_iter().take(6).map(Value::String).collect()),
        );
    }
}

pub(super) fn hydrate_understanding(
    payload: &mut Map<String, Value>,
    category: &str,
    sensitive: bool,
) {
    let facet = payload.get("facet").and_then(Value::as_str);
    let summary = payload.get("summary").and_then(Value::as_str).unwrap_or("");
    let mut inferred = Map::new();
    inferred.insert("summary".into(), Value::String(summary.to_owned()));
    if let Some(facet) = facet {
        inferred.insert("facet".into(), Value::String(facet.to_owned()));
    }
    defaults(&mut inferred, category, sensitive);

    for (key, allowed) in [
        (
            "layer",
            &[
                "stable_disposition",
                "contextual_adaptation",
                "current_attention",
                "narrative_meaning",
            ][..],
        ),
        ("temporal_scope", &["transient", "active", "durable"]),
        (
            "decay_policy",
            &[
                "days_7",
                "days_30",
                "reinforce_or_decay",
                "never_without_consent",
            ],
        ),
        ("sensitivity", &["normal", "sensitive", "restricted"]),
    ] {
        let selected = valid_scalar(payload.get(key), allowed)
            .or_else(|| inferred.get(key).and_then(Value::as_str))
            .unwrap_or("");
        payload.insert(key.into(), Value::String(selected.to_owned()));
    }
    for key in [
        "applies_when",
        "butler_should",
        "butler_should_not",
        "contradiction_refs",
    ] {
        let mut values = normalized_list(payload, key);
        if values.is_empty() && key != "contradiction_refs" {
            values = normalized_list(&inferred, key);
        }
        payload.insert(
            key.into(),
            Value::Array(values.into_iter().take(6).map(Value::String).collect()),
        );
    }
}

fn normalized_list(payload: &Map<String, Value>, key: &str) -> Vec<String> {
    unique(
        strings(&Value::Object(payload.clone()), key)
            .into_iter()
            .map(|value| normalize_text(&value, 320))
            .filter(|value| !value.is_empty())
            .collect(),
    )
}

fn valid_scalar<'a>(value: Option<&'a Value>, allowed: &[&str]) -> Option<&'a str> {
    value
        .and_then(Value::as_str)
        .filter(|value| allowed.contains(value))
}
pub(super) fn ready(payload: &Value, category: &str, source: &str, confidence: &str) -> bool {
    source == "user_confirmed"
        || (source == "explicit" && confidence == "high")
        || (strings(payload, "evidence_refs")
            .iter()
            .any(|value| value.starts_with("third_party_profile_import:"))
            && confidence != "low")
        || (payload
            .get("evidence_count")
            .and_then(Value::as_f64)
            .is_some_and(|value| value >= 2.0)
            && confidence != "low")
        || (category == "cares"
            && text(payload, "facet") == Some("current_interests")
            && source == "explicit"
            && confidence != "low"
            && !payload
                .get("sensitive_domain")
                .and_then(Value::as_bool)
                .unwrap_or(false))
}
pub(super) fn category_allowed(category: &str, mode: ProfilingMode) -> bool {
    allowed_category(category)
        && (mode == ProfilingMode::Deep
            || mode == ProfilingMode::Basic
                && matches!(category, "communication" | "epistemic_style" | "boundaries"))
}

pub(super) fn normalize_facet(value: Option<&str>) -> Option<&str> {
    value.filter(|value| {
        matches!(
            *value,
            "self_descriptions"
                | "roles"
                | "commitments"
                | "current_interests"
                | "enduring_interests"
                | "meaningful_objects"
                | "explicit_values"
                | "inferred_values"
                | "disliked_values"
                | "meaningful_events"
                | "turning_points"
                | "unresolved_threads"
                | "goals"
                | "active_projects"
                | "tensions"
                | "avoidance_patterns"
                | "how_the_user_thinks"
                | "evidence_preference"
                | "uncertainty_tolerance"
                | "correction_style"
                | "tone_preference"
                | "explanation_preference"
                | "emotional_mode"
                | "energizers"
                | "frustrations"
                | "comfort_patterns"
                | "important_people_or_groups"
                | "collaboration_preferences"
                | "social_boundaries"
                | "taste"
                | "anti_taste"
                | "quality_sense"
                | "privacy_rules"
                | "consent_required"
                | "sensitive_domains"
        )
    })
}

pub(super) fn normalize_sensitive(category: &str, facet: Option<&str>, declared: bool) -> bool {
    if matches!(facet, Some("privacy_rules" | "consent_required")) || !declared {
        return false;
    }
    !matches!(category, "communication" | "epistemic_style" | "aesthetics")
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

fn allowed_category(value: &str) -> bool {
    matches!(
        value,
        "identity"
            | "cares"
            | "values"
            | "narrative"
            | "agency"
            | "epistemic_style"
            | "communication"
            | "affective_landscape"
            | "relationships"
            | "aesthetics"
            | "boundaries"
    )
}
pub(super) fn identifier(
    prefix: &str,
    category: &str,
    facet: Option<&str>,
    summary: &str,
) -> String {
    let mut hash = Sha256::new();
    hash.update(category);
    hash.update([0]);
    hash.update(facet.unwrap_or(""));
    hash.update([0]);
    hash.update(summary);
    format!("{prefix}{}", &format!("{:x}", hash.finalize())[..16])
}
pub(super) fn stronger<'a>(left: Option<&'a str>, right: &'a str, order: &[&str]) -> &'a str {
    let rank = |value: &str| order.iter().position(|item| *item == value).unwrap_or(0);
    left.filter(|left| rank(left) >= rank(right))
        .unwrap_or(right)
}
pub(super) fn unique(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter(|value| seen.insert(value.clone()))
        .collect()
}
pub(super) fn normalize_text(value: &str, limit: usize) -> String {
    let compact = super::super::naming::collapse_js_whitespace(value);
    super::super::naming::bounded(&compact, limit)
}
pub(super) fn strings(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}
pub(super) fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}
pub(super) fn parse_time(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|value| value.timestamp_millis())
}
