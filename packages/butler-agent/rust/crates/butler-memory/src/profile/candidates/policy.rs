//! Candidate policy: the understanding inferred from category and facet,
//! how a new observation merges with what is stored, when a candidate is
//! ready for the stable profile, and the normalization rules shared by
//! writes and reads.

use std::collections::HashSet;

use sha2::{Digest, Sha256};

use super::super::contracts::{ProfileCandidateRecord, ProfilingMode};
use super::super::understanding::{
    CandidateDraft, Confidence, DecayPolicy, Layer, Sensitivity, SourceType, StoredUnderstanding,
    TemporalScope,
};

/// Layer, lifetime, sensitivity and behaviour lists of an entry.
pub(super) struct Shape {
    pub layer: Layer,
    pub temporal_scope: TemporalScope,
    pub decay_policy: DecayPolicy,
    pub sensitivity: Sensitivity,
    pub applies_when: Vec<String>,
    pub butler_should: Vec<String>,
    pub butler_should_not: Vec<String>,
    pub contradiction_refs: Vec<String>,
}

/// The shape of an entry that only its category, facet and summary are
/// known for.
fn inferred(category: &str, facet: Option<&str>, summary: &str, sensitive: bool) -> Shape {
    let layer = infer_layer(category, facet);
    Shape {
        layer,
        temporal_scope: if matches!(layer, Layer::StableDisposition | Layer::NarrativeMeaning) {
            TemporalScope::Durable
        } else {
            TemporalScope::Active
        },
        decay_policy: if layer == Layer::CurrentAttention {
            DecayPolicy::Days30
        } else if sensitive {
            DecayPolicy::NeverWithoutConsent
        } else {
            DecayPolicy::ReinforceOrDecay
        },
        sensitivity: if sensitive {
            Sensitivity::Sensitive
        } else {
            Sensitivity::Normal
        },
        applies_when: owned(infer_applies_when(category, facet)),
        butler_should: owned(infer_should(category, facet, summary)),
        butler_should_not: owned(infer_should_not(category, facet)),
        contradiction_refs: Vec::new(),
    }
}

fn infer_layer(category: &str, facet: Option<&str>) -> Layer {
    if category == "cares" || matches!(facet, Some("current_interests" | "active_projects")) {
        Layer::CurrentAttention
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
        Layer::NarrativeMeaning
    } else if matches!(category, "communication" | "epistemic_style" | "boundaries")
        || matches!(
            facet,
            Some("collaboration_preferences" | "correction_style" | "evidence_preference")
        )
    {
        Layer::ContextualAdaptation
    } else {
        Layer::StableDisposition
    }
}

fn owned(values: Vec<&str>) -> Vec<String> {
    values.into_iter().map(str::to_owned).collect()
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

/// Merges a new draft with the stored candidate: each scalar keeps the
/// draft's value, then the stored one, then the inferred one; lists keep the
/// stored, drafted and inferred items (at most six, normalized, unique).
pub(super) fn merge_understanding(
    draft: &CandidateDraft,
    previous: Option<&ProfileCandidateRecord>,
    category: &str,
    summary: &str,
    sensitive: bool,
) -> Shape {
    let inferred = inferred(category, draft.facet.as_deref(), summary, sensitive);
    let sensitivity = draft
        .sensitivity
        .or(previous.map(|value| value.understanding.sensitivity))
        .unwrap_or(inferred.sensitivity);
    let list = |stored: fn(&ProfileCandidateRecord) -> &Vec<String>,
                drafted: &[String],
                inferred: &[String]| {
        let mut values = previous.map(stored).cloned().unwrap_or_default();
        values.extend_from_slice(drafted);
        values.extend_from_slice(inferred);
        bounded_list(values.iter())
    };
    Shape {
        layer: draft
            .layer
            .or(previous.map(|value| value.layer))
            .unwrap_or(inferred.layer),
        temporal_scope: draft
            .temporal_scope
            .or(previous.map(|value| value.understanding.temporal_scope))
            .unwrap_or(inferred.temporal_scope),
        decay_policy: draft
            .decay_policy
            .or(previous.map(|value| value.understanding.decay_policy))
            .unwrap_or(inferred.decay_policy),
        sensitivity: if sensitive {
            sensitivity
        } else {
            Sensitivity::Normal
        },
        applies_when: list(
            |value| &value.understanding.applies_when,
            &draft.applies_when,
            &inferred.applies_when,
        ),
        butler_should: list(
            |value| &value.understanding.butler_should,
            &draft.butler_should,
            &inferred.butler_should,
        ),
        butler_should_not: list(
            |value| &value.understanding.butler_should_not,
            &draft.butler_should_not,
            &inferred.butler_should_not,
        ),
        contradiction_refs: list(
            |value| &value.understanding.contradiction_refs,
            &draft.contradiction_refs,
            &[],
        ),
    }
}

/// The shape of a stored candidate: each valid stored value, else the
/// inferred one; a list that is empty after normalization falls back to the
/// inferred list (except corrections).
pub(super) fn hydrate_understanding(
    stored: &StoredUnderstanding,
    category: &str,
    facet: Option<&str>,
    summary: &str,
    sensitive: bool,
) -> Shape {
    let inferred = inferred(category, facet, summary, sensitive);
    let list = |stored: &[String], inferred: &[String]| {
        let values = bounded_list(stored.iter());
        if values.is_empty() {
            bounded_list(inferred.iter())
        } else {
            values
        }
    };
    Shape {
        layer: stored.layer.unwrap_or(inferred.layer),
        temporal_scope: stored.temporal_scope.unwrap_or(inferred.temporal_scope),
        decay_policy: stored.decay_policy.unwrap_or(inferred.decay_policy),
        sensitivity: stored.sensitivity.unwrap_or(inferred.sensitivity),
        applies_when: list(&stored.applies_when, &inferred.applies_when),
        butler_should: list(&stored.butler_should, &inferred.butler_should),
        butler_should_not: list(&stored.butler_should_not, &inferred.butler_should_not),
        contradiction_refs: bounded_list(stored.contradiction_refs.iter()),
    }
}

/// At most six normalized, non-empty, unique items.
fn bounded_list<'a>(values: impl Iterator<Item = &'a String>) -> Vec<String> {
    unique(
        values
            .map(|value| normalize_text(value, 320))
            .filter(|value| !value.is_empty())
            .collect(),
    )
    .into_iter()
    .take(6)
    .collect()
}

/// Whether a candidate has enough evidence to join the stable profile.
pub(super) fn ready(candidate: &ProfileCandidateRecord) -> bool {
    let understanding = &candidate.understanding;
    let source = candidate.source_type;
    let confident = candidate.confidence != Confidence::Low;
    source == SourceType::UserConfirmed
        || (source == SourceType::Explicit && candidate.confidence == Confidence::High)
        || (understanding
            .evidence_refs
            .iter()
            .any(|value| value.starts_with("third_party_profile_import:"))
            && confident)
        || (understanding
            .evidence_count
            .as_f64()
            .is_some_and(|value| value >= 2.0)
            && confident)
        || (candidate.category == "cares"
            && understanding.facet.as_deref() == Some("current_interests")
            && source == SourceType::Explicit
            && confident
            && !candidate.sensitive_domain)
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
    let digest = format!("{:x}", hash.finalize());
    format!("{prefix}{}", digest.get(..16).unwrap_or(&digest))
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

pub(super) fn parse_time(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|value| value.timestamp_millis())
}
