mod apply;
mod prepare;
pub(in crate::cognition) use apply::{apply, apply_repair};
pub(in crate::cognition) use prepare::prepare;

use super::{
    CandidateSearchInput, CognitionCandidateSearch, ExtractCandidate, ExtractInput, ExtractOutput,
    Meaning, NodeResolution, Passage, QuoteRef,
};
use crate::cognition::{CognitionError, CognitionResult};
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};

pub(super) struct BindingBatch {
    pub prompt: Value,
    pub targets: Vec<Target>,
    pub quotes: HashMap<String, QuoteRef>,
}
pub(super) struct Target {
    pub local_ref: String,
    pub candidates: HashMap<String, ExtractCandidate>,
    pub current_refs: HashSet<String>,
    pub historical_refs: HashMap<String, HashSet<String>>,
    pub spans: HashMap<String, Span>,
    pub change: bool,
}
#[derive(Clone)]
pub(super) struct Span {
    pub candidate: String,
    pub start: usize,
    pub end: usize,
    pub value: String,
}

fn historical_quote(candidate: &ExtractCandidate) -> Option<(QuoteRef, String)> {
    for unit in &candidate.evidence {
        for sentence in crate::segmentation::sentence_segments(&unit.text) {
            if std::iter::once(&candidate.label)
                .chain(candidate.aliases.iter())
                .any(|alias| !alias.is_empty() && sentence.text.contains(alias))
            {
                let occurrence = unit.text[..sentence.start]
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
pub(super) fn repair_schema(batch: &BindingBatch) -> Map<String, Value> {
    let offered = batch.prompt["targets"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let target_refs = offered
        .iter()
        .map(|t| t["target"].clone())
        .collect::<Vec<_>>();
    let candidates = offered
        .iter()
        .flat_map(|t| t["candidates"].as_array().cloned().unwrap_or_default())
        .collect::<Vec<_>>();
    let candidate_refs = candidates
        .iter()
        .map(|c| c["ref"].clone())
        .collect::<Vec<_>>();
    let span_refs = std::iter::once(Value::Null)
        .chain(
            candidates
                .iter()
                .flat_map(|c| c["spans"].as_array().cloned().unwrap_or_default())
                .map(|s| s["ref"].clone()),
        )
        .collect::<Vec<_>>();
    let current_refs = offered
        .iter()
        .flat_map(|t| t["evidence"].as_array().cloned().unwrap_or_default())
        .collect::<Vec<_>>();
    let historical_refs = candidates
        .iter()
        .flat_map(|c| c["evidence"].as_array().cloned().unwrap_or_default())
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
    crate::json::json_object!({"type":"object","additionalProperties":false,"required":["decisions"],"properties":{"decisions":{"type":"array","maxItems":4,"items":item}}})
}
fn error(code: &'static str) -> CognitionError {
    CognitionError::new(code, code)
}
fn json_error(e: impl std::fmt::Display) -> CognitionError {
    CognitionError::new("memory_extract_invalid_json", e.to_string())
}

#[cfg(test)]
mod tests;
