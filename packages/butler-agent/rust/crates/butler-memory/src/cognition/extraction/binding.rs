//! Binding stage: after the meaning stage, each entity and each stated change
//! is offered existing graph candidates, and the model decides which one (if
//! any) the new fact is about, backed by current and historical evidence.
//!
//! [`prepare`] searches candidates and packs targets into prompt batches;
//! [`apply`] checks the model's decisions and rewrites the output: an entity
//! decision reuses a node, a change decision rewrites the chosen span of a past
//! claim and records a correction.

mod apply;
mod prepare;
pub(in crate::cognition) use apply::{BindingWarning, apply, apply_repair};
pub(in crate::cognition) use prepare::prepare;

use super::{
    CandidateSearchInput, CognitionCandidateSearch, ExtractCandidate, ExtractInput, ExtractOutput,
    Meaning, NodeResolution, Passage, QuoteRef, meaning::ChangeItem,
};
use crate::cognition::CognitionCode;
use crate::cognition::{CognitionError, CognitionResult};
use serde::Serialize;
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};

/// Targets offered in one binding call (at most 4, within a 3 KiB prompt).
pub(super) struct BindingBatch {
    pub prompt: BindingPrompt,
    pub targets: Vec<Target>,
    pub quotes: HashMap<String, QuoteRef>,
}

/// The binding call input shown to the model.
#[derive(Clone, Default, Serialize)]
pub(super) struct BindingPrompt {
    pub targets: Vec<PromptTarget>,
    pub evidence: Vec<PromptEvidence>,
}

/// One target: what it means now, its current evidence refs and candidates.
#[derive(Clone, Serialize)]
pub(super) struct PromptTarget {
    pub target: String,
    pub meaning: TargetMeaning,
    pub evidence: Vec<String>,
    pub candidates: Vec<PromptCandidate>,
}

/// An entity target shows its name; a change target shows the change item.
#[derive(Clone, Serialize)]
#[serde(untagged)]
pub(super) enum TargetMeaning {
    Entity { name: String },
    Item(TaggedItem),
}

/// A meaning item with its contract `kind` tag.
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(super) enum TaggedItem {
    Change(ChangeItem),
}

/// Quoted evidence, current (`role: "current"`) or historical (the basis of
/// the candidate's source).
#[derive(Clone, Serialize)]
pub(super) struct PromptEvidence {
    #[serde(rename = "ref")]
    pub reference: String,
    pub text: String,
    pub role: String,
}

/// An existing node offered for a target; change candidates list the spans
/// of their statement that the change may replace.
#[derive(Clone, Serialize)]
pub(super) struct PromptCandidate {
    #[serde(rename = "ref")]
    pub reference: String,
    #[serde(rename = "type")]
    pub node_type: String,
    pub label: String,
    pub evidence: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spans: Option<Vec<PromptSpan>>,
}

/// An occurrence of the change's old value inside a candidate statement.
#[derive(Clone, Serialize)]
pub(super) struct PromptSpan {
    #[serde(rename = "ref")]
    pub reference: String,
    pub before: String,
    pub value: String,
    pub after: String,
}

/// What `apply` needs to check one target's decision.
pub(super) struct Target {
    pub local_ref: String,
    pub candidates: HashMap<String, ExtractCandidate>,
    pub current_refs: HashSet<String>,
    pub historical_refs: HashMap<String, HashSet<String>>,
    pub spans: HashMap<String, Span>,
    pub change: bool,
}
/// A replaceable span of a candidate statement and its new value.
#[derive(Clone)]
pub(super) struct Span {
    pub candidate: String,
    pub start: usize,
    pub end: usize,
    pub value: String,
}

/// The first sentence of a candidate's evidence that names it (label or
/// alias), with that evidence's basis.
fn historical_quote(candidate: &ExtractCandidate) -> Option<(QuoteRef, String)> {
    for unit in &candidate.evidence {
        for sentence in butler_core::segmentation::sentence_segments(&unit.text) {
            if std::iter::once(&candidate.label)
                .chain(candidate.aliases.iter())
                .any(|alias| !alias.is_empty() && sentence.text.contains(alias))
            {
                let occurrence = unit
                    .text
                    .get(..sentence.start)
                    .unwrap_or_default()
                    .match_indices(sentence.text)
                    .count();
                return Some((
                    QuoteRef {
                        unit_ref: unit.ref_id.clone(),
                        quote: sentence.text.into(),
                        occurrence,
                    },
                    unit.basis.clone(),
                ));
            }
        }
    }
    None
}

/// The strict repair-call schema: the first call's schema with every ref
/// narrowed to the refs this batch offered. Passthrough: a JSON Schema
/// document sent to the provider as the structured-output contract.
pub(super) fn repair_schema(batch: &BindingBatch) -> Map<String, Value> {
    let offered = &batch.prompt.targets;
    let target_refs = offered.iter().map(|t| &t.target).collect::<Vec<_>>();
    let candidates = offered
        .iter()
        .flat_map(|t| &t.candidates)
        .collect::<Vec<_>>();
    let candidate_refs = candidates.iter().map(|c| &c.reference).collect::<Vec<_>>();
    let span_refs = std::iter::once(None)
        .chain(
            candidates
                .iter()
                .flat_map(|c| c.spans.iter().flatten())
                .map(|s| Some(&s.reference)),
        )
        .collect::<Vec<_>>();
    let current_refs = offered.iter().flat_map(|t| &t.evidence).collect::<Vec<_>>();
    let historical_refs = candidates
        .iter()
        .flat_map(|c| &c.evidence)
        .collect::<Vec<_>>();
    let object = |properties: Value| json!({"type":"object","additionalProperties":false,"required":["target","candidate","span","current_support","selected_historical_support"],"properties":properties});
    let null_decision = object(
        json!({"target":{"type":"string","enum":target_refs},"candidate":{"type":"null"},"span":{"type":"null"},
        "current_support":{"type":"array","maxItems":0,"items":{"type":"string"}},"selected_historical_support":{"type":"array","maxItems":0,"items":{"type":"string"}}}),
    );
    let selected_decision = object(
        json!({"target":{"type":"string","enum":target_refs},"candidate":{"type":"string","enum":candidate_refs},
        "span":{"type":["string","null"],"enum":span_refs},"current_support":{"type":"array","minItems":1,"maxItems":3,"items":{"type":"string","enum":current_refs}},
        "selected_historical_support":{"type":"array","minItems":1,"maxItems":1,"items":{"type":"string","enum":historical_refs}}}),
    );
    let item = if candidates.is_empty() {
        null_decision
    } else {
        json!({"anyOf":[null_decision,selected_decision]})
    };
    butler_core::json::json_object!({"type":"object","additionalProperties":false,"required":["decisions"],"properties":{"decisions":{"type":"array","maxItems":4,"items":item}}})
}
fn error(code: CognitionCode) -> CognitionError {
    CognitionError::new(code, code.as_str())
}
fn json_error(e: impl std::error::Error + Send + Sync + 'static) -> CognitionError {
    CognitionError::new(CognitionCode::MemoryExtractInvalidJson, e.to_string()).with_source(e)
}

#[cfg(test)]
mod tests;
