//! Validate model output against its pinned input before durable apply.

use std::collections::{HashMap, HashSet};

use indexmap::IndexMap;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::db_error;
use crate::cognition::{
    CognitionError, CognitionResult,
    extraction::{ExtractCandidate, ExtractInput, ExtractOutput, NodeResolution, QuoteRef},
};
mod condition;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(in crate::cognition) struct NormalizedPlan {
    pub refs: IndexMap<String, String>,
    pub evidence: IndexMap<String, Vec<ValidatedQuote>>,
    pub candidate_bindings: IndexMap<String, CandidateBinding>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(in crate::cognition) struct ValidatedQuote {
    #[serde(rename = "sourceId")]
    pub source_id: String,
    #[serde(rename = "byteStart")]
    pub byte_start: usize,
    #[serde(rename = "byteEnd")]
    pub byte_end: usize,
    pub quote: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(in crate::cognition) struct CandidateBinding {
    pub node_ref: String,
    #[serde(rename = "type")]
    pub node_type: String,
    pub scope: String,
    pub project_id: Option<String>,
    pub evidence: Vec<CandidateSource>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(in crate::cognition) struct CandidateSource {
    pub source_ref: String,
    pub episode_ref: String,
    pub revision: String,
    pub content_hash: String,
}

pub(super) fn normalize(
    connection: &Connection,
    input: &ExtractInput,
    output: &ExtractOutput,
) -> CognitionResult<NormalizedPlan> {
    if output.disposition == "unsupported" {
        return Ok(NormalizedPlan {
            refs: IndexMap::new(),
            evidence: IndexMap::new(),
            candidate_bindings: IndexMap::new(),
        });
    }
    let candidates = input
        .candidates
        .iter()
        .map(|candidate| (candidate.ref_id.as_str(), candidate))
        .collect::<HashMap<_, _>>();
    let mut refs = IndexMap::new();
    let mut selected = IndexMap::<String, &ExtractCandidate>::new();
    for node in &output.nodes {
        if crate::segmentation::grapheme_segments(&node.label).count() > 256 {
            return Err(invalid_output());
        }
        validate_resolution(
            input,
            &candidates,
            &node.node_type,
            &node.resolution,
            &mut selected,
            &node.local_ref,
        )?;
        refs.insert(
            node.local_ref.clone(),
            hash(vec![
                json!("memory-node"),
                json!(input.window_ref),
                json!(node.local_ref),
                json!(node.label),
            ])?,
        );
    }
    for claim in &output.claims {
        if crate::segmentation::grapheme_segments(&claim.statement).count() > 1024 {
            return Err(invalid_output());
        }
        validate_resolution(
            input,
            &candidates,
            &claim.claim_type,
            &claim.resolution,
            &mut selected,
            &claim.local_ref,
        )?;
        let mut content = serde_json::to_value(claim).map_err(json_error)?;
        if let Some(object) = content.as_object_mut() {
            object.shift_remove("resolution");
        }
        refs.insert(
            claim.local_ref.clone(),
            hash(vec![
                json!("memory-claim"),
                json!(input.window_ref),
                content,
            ])?,
        );
    }
    if refs.len() != output.nodes.len() + output.claims.len() {
        return Err(invalid_output());
    }
    let mut evidence = IndexMap::new();
    for node in &output.nodes {
        evidence.insert(
            node.local_ref.clone(),
            validate_quotes(input, &node.evidence, true)?,
        );
        if node.aliases.len() > 8 {
            return Err(invalid_output());
        }
        for alias in &node.aliases {
            if crate::segmentation::grapheme_segments(&alias.text).count() > 256 {
                return Err(invalid_output());
            }
            validate_quotes(input, &alias.evidence, true)?;
        }
    }
    for claim in &output.claims {
        evidence.insert(
            claim.local_ref.clone(),
            validate_quotes(input, &claim.evidence, true)?,
        );
        if claim
            .subject_ref
            .as_ref()
            .is_some_and(|reference| !refs.contains_key(reference))
            || claim
                .object_ref
                .as_ref()
                .is_some_and(|reference| !refs.contains_key(reference))
        {
            return Err(error("memory_extract_invalid_ref"));
        }
        if claim
            .condition
            .as_ref()
            .is_some_and(|value| crate::segmentation::grapheme_segments(value).count() > 1024)
        {
            return Err(invalid_output());
        }
        if let Some(requirement) = &claim.requirement {
            if output.schema != "butler.memory-extract-output.v3"
                || claim.claim_type != "constraint"
                || claim.subject_ref.is_none()
            {
                return Err(error("memory_extract_invalid_condition"));
            }
            condition::validate(requirement, &refs)?;
        }
        validate_basis(input, &claim.basis, &claim.evidence)?;
    }
    let claims = output
        .claims
        .iter()
        .map(|claim| (claim.local_ref.as_str(), claim))
        .collect::<HashMap<_, _>>();
    for relation in &output.relations {
        let claim = claims
            .get(relation.claim_ref.as_str())
            .ok_or_else(|| error("memory_extract_invalid_relation"))?;
        if claim.speech_act != "assertion"
            || claim.subject_ref.as_deref() != Some(&relation.from_ref)
            || claim.object_ref.as_deref() != Some(&relation.to_ref)
        {
            return Err(error("memory_extract_invalid_relation"));
        }
        validate_quotes(input, &relation.evidence, true)?;
    }
    for correction in &output.corrections {
        if !claims.contains_key(correction.replacement_claim_ref.as_str()) {
            return Err(error("memory_extract_invalid_ref"));
        }
        let candidate = candidates
            .get(correction.previous_claim_ref.as_str())
            .ok_or_else(|| error("memory_extract_invalid_ref"))?;
        selected.insert(
            format!("correction:{}", correction.previous_claim_ref),
            candidate,
        );
        validate_quotes(input, &correction.evidence, true)?;
    }
    if let Some(summary) = &output.summary {
        if crate::segmentation::grapheme_segments(&summary.text).count() > 480 {
            return Err(invalid_output());
        }
        validate_quotes(input, &summary.evidence, true)?;
    }
    let mut candidate_bindings = IndexMap::new();
    for (key, candidate) in selected {
        candidate_bindings.insert(key, candidate_binding(connection, candidate)?);
    }
    Ok(NormalizedPlan {
        refs,
        evidence,
        candidate_bindings,
    })
}

fn validate_resolution<'a>(
    input: &ExtractInput,
    candidates: &HashMap<&str, &'a ExtractCandidate>,
    node_type: &str,
    resolution: &NodeResolution,
    selected: &mut IndexMap<String, &'a ExtractCandidate>,
    local_ref: &str,
) -> CognitionResult<()> {
    match resolution {
        NodeResolution::Create { identity_scope, .. } => {
            if identity_scope == "project" && input.bound_project_id.is_none() {
                return Err(error("memory_extract_invalid_scope"));
            }
        }
        NodeResolution::Reuse {
            node_ref, evidence, ..
        } => {
            let candidate = candidates
                .get(node_ref.as_str())
                .ok_or_else(|| error("memory_extract_invalid_identity_reuse"))?;
            if candidate.node_type != node_type
                || (candidate.scope == "project" && candidate.project_id != input.bound_project_id)
            {
                return Err(error("memory_extract_invalid_identity_reuse"));
            }
            let quotes = validate_quotes(input, evidence, true)?;
            let historical = candidate
                .evidence
                .iter()
                .map(|unit| unit.ref_id.as_str())
                .collect::<HashSet<_>>();
            if !quotes
                .iter()
                .any(|quote| historical.contains(quote.source_id.as_str()))
            {
                return Err(error("memory_extract_invalid_identity_reuse"));
            }
            selected.insert(local_ref.into(), candidate);
        }
    }
    Ok(())
}

fn candidate_binding(
    connection: &Connection,
    candidate: &ExtractCandidate,
) -> CognitionResult<CandidateBinding> {
    let mut evidence = Vec::new();
    for unit in &candidate.evidence {
        let row=connection.query_row("SELECT source_id,episode_id,revision,content_hash FROM memory_chunk_sources WHERE source_id=?1",[&unit.ref_id],|row|Ok(CandidateSource{source_ref:row.get(0)?,episode_ref:row.get(1)?,revision:row.get(2)?,content_hash:row.get(3)?})).optional().map_err(db_error)?.ok_or_else(||error("memory_extract_candidate_changed"))?;
        evidence.push(row);
    }
    evidence.sort_by(|a, b| a.source_ref.cmp(&b.source_ref));
    Ok(CandidateBinding {
        node_ref: candidate.ref_id.clone(),
        node_type: candidate.node_type.clone(),
        scope: candidate.scope.clone(),
        project_id: candidate.project_id.clone(),
        evidence,
    })
}

fn validate_quotes(
    input: &ExtractInput,
    quotes: &[QuoteRef],
    require_current: bool,
) -> CognitionResult<Vec<ValidatedQuote>> {
    if quotes.len() > 8 {
        return Err(error("memory_extract_invalid_quote"));
    }
    let mut units = HashMap::new();
    for unit in &input.source_units {
        units.insert(unit.ref_id.as_str(), unit.text.as_str());
    }
    for unit in &input.context_units {
        units.insert(unit.ref_id.as_str(), unit.text.as_str());
    }
    for candidate in &input.candidates {
        for unit in &candidate.evidence {
            units.insert(unit.ref_id.as_str(), unit.text.as_str());
        }
    }
    let current = input
        .source_units
        .iter()
        .map(|unit| unit.ref_id.as_str())
        .collect::<HashSet<_>>();
    let mut has_current = false;
    let mut validated = Vec::with_capacity(quotes.len());
    for quote in quotes {
        let text = units
            .get(quote.unit_ref.as_str())
            .ok_or_else(|| error("memory_extract_invalid_quote"))?;
        if quote.quote.is_empty()
            || crate::segmentation::grapheme_segments(&quote.quote).count() > 480
        {
            return Err(error("memory_extract_invalid_quote"));
        }
        let (start, _) = text
            .match_indices(&quote.quote)
            .nth(quote.occurrence)
            .ok_or_else(|| error("memory_extract_invalid_quote"))?;
        let end = start + quote.quote.len();
        if current.contains(quote.unit_ref.as_str()) {
            has_current = true;
        }
        if let Some(context) = input
            .context_units
            .iter()
            .find(|unit| unit.ref_id == quote.unit_ref)
            && let Some(span) = &context.source_span
            && current.contains(span.source_ref.as_str())
            && start < span.prefix_bytes as usize + (span.focus_end - span.focus_start) as usize
            && end > span.prefix_bytes as usize
        {
            has_current = true;
        }
        validated.push(ValidatedQuote {
            source_id: quote.unit_ref.clone(),
            byte_start: start,
            byte_end: end,
            quote: quote.quote.clone(),
        });
    }
    if require_current && !has_current {
        return Err(error("memory_extract_invalid_quote"));
    }
    Ok(validated)
}

pub(in crate::cognition::graph) fn validate_quotes_for_apply(
    input: &ExtractInput,
    quotes: &[QuoteRef],
) -> CognitionResult<Vec<ValidatedQuote>> {
    validate_quotes(input, quotes, true)
}

fn validate_basis(input: &ExtractInput, basis: &str, quotes: &[QuoteRef]) -> CognitionResult<()> {
    let current = input
        .source_units
        .iter()
        .map(|unit| (unit.ref_id.as_str(), unit.role.as_str()))
        .collect::<HashMap<_, _>>();
    for quote in quotes {
        if let Some(role) = current.get(quote.unit_ref.as_str())
            && ((basis == "user_statement" && *role != "user")
                || (basis == "assistant_statement" && *role != "assistant"))
        {
            return Err(error("memory_extract_invalid_basis"));
        }
    }
    Ok(())
}

fn hash(value: Vec<Value>) -> CognitionResult<String> {
    Ok(crate::cognition::sources::projection_hash_for_graph(value)?)
}
fn error(code: &'static str) -> CognitionError {
    CognitionError::new(code, code)
}
fn invalid_output() -> CognitionError {
    error("memory_extract_invalid_output")
}
fn json_error(error: impl std::fmt::Display) -> CognitionError {
    CognitionError::new("memory_extract_invalid_json", error.to_string())
}
