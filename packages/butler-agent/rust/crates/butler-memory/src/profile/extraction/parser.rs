//! Extractor responses: the strict parser used for transcript capture
//! (every candidate must validate) and the forgiving one used for
//! third-party imports (invalid candidates are dropped).

use std::collections::{HashMap, HashSet};

use serde::Deserialize;
use serde_json::{Map, Value};

use super::super::contracts::{ProfileError, ProfileResult, ProfilingMode};
use super::super::understanding::{
    CandidateDraft, Confidence, DecayPolicy, Expiry, Layer, Sensitivity, SourceType, TemporalScope,
};
use super::types::{CorrectionTarget, ExtractedCandidate};
use crate::lenient::{self, Arg};
use crate::profile::ProfileCode;
use values::{valid_category, valid_facet};

mod values;

/// A candidate as the model returned it; a field with the wrong type reads
/// as absent.
#[derive(Default, Deserialize)]
#[serde(default)]
struct RawCandidate {
    #[serde(deserialize_with = "lenient::option")]
    category: Option<String>,
    #[serde(deserialize_with = "lenient::option")]
    summary: Option<String>,
    #[serde(deserialize_with = "lenient::option")]
    facet: Option<String>,
    #[serde(deserialize_with = "lenient::option")]
    layer: Option<Layer>,
    #[serde(deserialize_with = "lenient::string_list")]
    applies_when: Vec<String>,
    #[serde(deserialize_with = "lenient::string_list")]
    butler_should: Vec<String>,
    #[serde(deserialize_with = "lenient::string_list")]
    butler_should_not: Vec<String>,
    contradiction_refs: Arg<Vec<Arg<String>>>,
    #[serde(deserialize_with = "lenient::option")]
    temporal_scope: Option<TemporalScope>,
    #[serde(deserialize_with = "lenient::option")]
    decay_policy: Option<DecayPolicy>,
    #[serde(deserialize_with = "lenient::option")]
    sensitivity: Option<Sensitivity>,
    evidence_refs: Arg<Vec<Arg<String>>>,
    #[serde(deserialize_with = "lenient::option")]
    sensitive_domain: Option<bool>,
    #[serde(deserialize_with = "lenient::option")]
    source_type: Option<SourceType>,
    #[serde(deserialize_with = "lenient::option")]
    confidence: Option<Confidence>,
    #[serde(deserialize_with = "lenient::option")]
    expires_or_decay: Option<Expiry>,
}

impl RawCandidate {
    /// The string items of `contradiction_refs`.
    fn contradiction_texts(&self) -> impl Iterator<Item = &str> {
        valid_items(&self.contradiction_refs)
    }
}

/// The string items of an array field.
fn valid_items(field: &Arg<Vec<Arg<String>>>) -> impl Iterator<Item = &str> {
    field
        .valid()
        .into_iter()
        .flatten()
        .filter_map(Arg::valid)
        .map(String::as_str)
}

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
    items
        .iter()
        .map(|item| {
            if !item.is_object() {
                return Err(validation("profile extractor candidate has invalid shape"));
            }
            strict_candidate(&lenient::view(item), allowed, mode, targets)
        })
        .collect()
}

fn strict_candidate(
    raw: &RawCandidate,
    allowed: &HashSet<String>,
    mode: ProfilingMode,
    targets: &HashMap<String, CorrectionTarget>,
) -> ProfileResult<ExtractedCandidate> {
    let invalid_refs = || validation("profile extractor candidate has invalid evidence refs");
    let raw_refs = raw
        .evidence_refs
        .valid()
        .filter(|refs| !refs.is_empty())
        .ok_or_else(invalid_refs)?;
    if raw_refs.iter().any(|value| {
        value
            .valid()
            .map(|value| butler_core::public_text::trim_js_whitespace(value))
            .is_none_or(|value| !allowed.contains(value))
    }) {
        return Err(invalid_refs());
    }
    let mut candidate = normalize(raw, allowed, mode)
        .filter(|candidate| !candidate.evidence_refs.is_empty())
        .ok_or_else(|| validation("profile extractor candidate failed validation"))?;
    let invalid_corrections = || validation("profile extractor correction refs have invalid shape");
    if matches!(raw.contradiction_refs, Arg::Null | Arg::Invalid(_)) {
        return Err(invalid_corrections());
    }
    let raw_corrections = raw
        .contradiction_refs
        .valid()
        .map_or(&[][..], Vec::as_slice);
    if raw_corrections.iter().any(|value| {
        value
            .valid()
            .map(|value| butler_core::public_text::trim_js_whitespace(value))
            .is_none_or(str::is_empty)
    }) {
        return Err(invalid_corrections());
    }
    let requested = unique(
        raw.contradiction_texts()
            .map(|value| butler_core::public_text::trim_js_whitespace(value).to_owned())
            .collect(),
        usize::MAX,
    );
    let mut resolved = Vec::new();
    for reference in requested {
        let target = targets
            .get(&reference)
            .filter(|target| corrects(&candidate, target))
            .ok_or_else(|| validation("profile extractor correction target failed validation"))?;
        resolved.push(target.stable_id.clone());
    }
    resolved.truncate(6);
    candidate.draft.contradiction_refs = resolved;
    Ok(candidate)
}

/// Whether an explicit candidate keeps the target's category, facet and
/// conditions, as a correction must.
fn corrects(candidate: &ExtractedCandidate, target: &CorrectionTarget) -> bool {
    let conditions = unique(candidate.draft.applies_when.clone(), 6);
    candidate.source_type == SourceType::Explicit
        && candidate.category == target.category
        && candidate.draft.facet == target.facet
        && normalized_conditions(conditions) == target.applies_when
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
        .filter(|item| item.is_object())
        .filter_map(|item| normalize(&lenient::view(item), allowed, mode))
        .take(40)
        .collect()
}

fn normalize(
    raw: &RawCandidate,
    allowed: &HashSet<String>,
    mode: ProfilingMode,
) -> Option<ExtractedCandidate> {
    let category = valid_category(raw.category.as_deref()?)?;
    if mode == ProfilingMode::Off
        || mode == ProfilingMode::Basic
            && !matches!(category, "communication" | "epistemic_style" | "boundaries")
    {
        return None;
    }
    let summary = normalize_text(raw.summary.as_deref()?, 320);
    if summary.is_empty() {
        return None;
    }
    let facet = valid_facet(raw.facet.as_deref());
    let sensitive = normalize_sensitive(category, facet, raw.sensitive_domain == Some(true));
    let evidence_refs = unique(
        valid_items(&raw.evidence_refs)
            .map(butler_core::public_text::trim_js_whitespace)
            .filter(|value| allowed.contains(*value))
            .map(str::to_owned)
            .collect(),
        12,
    );
    let draft = CandidateDraft {
        summary,
        facet: facet.map(str::to_owned),
        layer: raw.layer,
        applies_when: bounded(raw.applies_when.iter().map(String::as_str)),
        butler_should: bounded(raw.butler_should.iter().map(String::as_str)),
        butler_should_not: bounded(raw.butler_should_not.iter().map(String::as_str)),
        contradiction_refs: bounded(raw.contradiction_texts()),
        temporal_scope: raw.temporal_scope,
        decay_policy: raw.decay_policy,
        sensitivity: if sensitive {
            raw.sensitivity
        } else {
            Some(Sensitivity::Normal)
        },
    };
    Some(ExtractedCandidate {
        draft,
        category: category.into(),
        source_type: raw.source_type.unwrap_or(SourceType::Inference),
        confidence: raw.confidence.unwrap_or(Confidence::Low),
        sensitive_domain: sensitive,
        evidence_refs,
        expires_or_decay: Some(match raw.expires_or_decay {
            Some(Expiry::Expires) => Expiry::Expires,
            _ => Expiry::Decay,
        }),
    })
}

fn strict_object(raw: &str) -> ProfileResult<Map<String, Value>> {
    let text = fences(raw);
    let value: Value = serde_json::from_str(text).map_err(|source| {
        validation("profile extractor response is invalid JSON").with_source(source)
    })?;
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
    let mut text = butler_core::public_text::trim_js_whitespace(raw);
    if text
        .get(..7)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("```json"))
    {
        text = &text[7..];
    } else if text.starts_with("```") {
        text = &text[3..];
    }
    text = butler_core::public_text::trim_js_whitespace(text);
    if let Some(value) = text.strip_suffix("```") {
        text = butler_core::public_text::trim_js_whitespace(value);
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
/// At most six normalized, non-empty, unique items.
fn bounded<'a>(values: impl Iterator<Item = &'a str>) -> Vec<String> {
    unique(
        values
            .map(|value| normalize_text(value, 240))
            .filter(|value| !value.is_empty())
            .collect(),
        6,
    )
}
fn unique(values: Vec<String>, limit: usize) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter(|value| seen.insert(value.clone()))
        .take(limit)
        .collect()
}
fn normalized_conditions(mut value: Vec<String>) -> Vec<String> {
    value = value
        .into_iter()
        .map(|value| butler_core::public_text::trim_js_whitespace(&value).to_owned())
        .filter(|value| !value.is_empty())
        .collect();
    value.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    value.dedup();
    value
}
fn validation(message: &str) -> ProfileError {
    ProfileError::new(ProfileCode::ProfileExtractorInvalid, message)
}

#[cfg(test)]
mod tests;
