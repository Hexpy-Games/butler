use std::collections::HashMap;

use rusqlite::{Connection, params};
use serde_json::{Value, json};

use super::{resolve_quotes, stringify};
use crate::cognition::{
    CognitionError, CognitionResult,
    extraction::{ExtractInput, ExtractOutput, NodeResolution, QuoteRef},
    graph::{db_error, plan::NormalizedPlan},
};

#[derive(Clone, Copy)]
pub(super) struct EdgeInput<'a> {
    pub input: &'a ExtractInput,
    pub plan: &'a NormalizedPlan,
    pub relation: &'a str,
    pub from: &'a str,
    pub to: &'a str,
    pub claim: &'a str,
    pub evidence: &'a [QuoteRef],
    pub basis: &'a str,
}

pub(super) fn add(tx: &Connection, edge_input: EdgeInput<'_>) -> CognitionResult<()> {
    let EdgeInput {
        input,
        plan,
        relation,
        from,
        to,
        claim,
        evidence,
        basis,
    } = edge_input;
    let from = plan.refs.get(from).ok_or_else(invalid_ref)?;
    let to = plan.refs.get(to).ok_or_else(invalid_ref)?;
    let claim = plan.refs.get(claim).ok_or_else(invalid_ref)?;
    let edge = hash(vec![
        json!("memory-edge"),
        json!(from),
        json!(to),
        json!(relation),
        json!(claim),
    ])?;
    tx.execute("INSERT OR IGNORE INTO edges(edge_id,source_node_id,target_node_id,rel_type,claim_node_id,qualifiers) VALUES(?1,?2,?3,?4,?5,'{}')",params![edge,from,to,relation,claim]).map_err(db_error)?;
    evidence_rows(tx, input, &edge, evidence, basis)
}

pub(super) fn identity_match(
    tx: &Connection,
    input: &ExtractInput,
    _plan: &NormalizedPlan,
    candidates: &HashMap<String, String>,
    local_id: &str,
    resolution: &NodeResolution,
) -> CognitionResult<()> {
    let NodeResolution::Reuse {
        node_ref, evidence, ..
    } = resolution
    else {
        return Ok(());
    };
    let target = candidates.get(node_ref).ok_or_else(candidate_changed)?;
    let edge = hash(vec![
        json!("identity-match"),
        json!(local_id),
        json!(target),
    ])?;
    tx.execute("INSERT OR IGNORE INTO edges(edge_id,source_node_id,target_node_id,rel_type,qualifiers) VALUES(?1,?2,?3,'identity_match','{}')",params![edge,local_id,target]).map_err(db_error)?;
    evidence_rows(tx, input, &edge, evidence, "inference")
}

pub(super) fn same_claim(
    tx: &Connection,
    input: &ExtractInput,
    _plan: &NormalizedPlan,
    candidates: &HashMap<String, String>,
    local_id: &str,
    resolution: &NodeResolution,
) -> CognitionResult<()> {
    let NodeResolution::Reuse {
        node_ref, evidence, ..
    } = resolution
    else {
        return Ok(());
    };
    let target = candidates.get(node_ref).ok_or_else(candidate_changed)?;
    let edge = hash(vec![json!("same-claim"), json!(local_id), json!(target)])?;
    tx.execute("INSERT OR IGNORE INTO edges(edge_id,source_node_id,target_node_id,rel_type,qualifiers) VALUES(?1,?2,?3,'same_claim','{}')",params![edge,local_id,target]).map_err(db_error)?;
    evidence_rows(tx, input, &edge, evidence, "inference")
}

pub(super) fn refinements_and_corrections(
    tx: &Connection,
    input: &ExtractInput,
    output: &ExtractOutput,
    plan: &NormalizedPlan,
) -> CognitionResult<()> {
    let meaning = tx
        .query_row(
            "SELECT plan_json FROM memory_meaning_commits WHERE window_ref=?1",
            [&input.window_ref],
            |row| row.get::<_, String>(0),
        )
        .ok();
    if let Some(meaning) = meaning {
        let old: NormalizedPlan = serde_json::from_str(&meaning).map_err(json_error)?;
        for claim in &output.claims {
            let Some(original) = old.refs.get(&claim.local_ref) else {
                continue;
            };
            let bound = plan.refs.get(&claim.local_ref).ok_or_else(invalid_ref)?;
            if original == bound {
                continue;
            }
            let edge = hash(vec![json!("refines"), json!(bound), json!(original)])?;
            tx.execute("INSERT OR IGNORE INTO edges(edge_id,source_node_id,target_node_id,rel_type,claim_node_id,qualifiers) VALUES(?1,?2,?3,'refines',?2,'{}')",params![edge,bound,original]).map_err(db_error)?;
            evidence_rows(tx, input, &edge, &claim.evidence, "inference")?;
        }
    }
    for correction in &output.corrections {
        let replacement = output
            .claims
            .iter()
            .find(|claim| claim.local_ref == correction.replacement_claim_ref)
            .ok_or_else(invalid_ref)?;
        let replacement_id = plan
            .refs
            .get(&correction.replacement_claim_ref)
            .ok_or_else(invalid_ref)?;
        let edge = hash(vec![
            json!("memory-edge"),
            json!(replacement_id),
            json!(correction.previous_claim_ref),
            json!(correction.relation),
            json!(replacement_id),
        ])?;
        tx.execute("INSERT OR IGNORE INTO edges(edge_id,source_node_id,target_node_id,rel_type,claim_node_id,qualifiers,valid_from) VALUES(?1,?2,?3,?4,?2,?5,?6)",params![edge,replacement_id,correction.previous_claim_ref,correction.relation,stringify(&json!({"effective_at":correction.effective_at}))?,correction.effective_at]).map_err(db_error)?;
        evidence_rows(tx, input, &edge, &correction.evidence, &replacement.basis)?;
    }
    Ok(())
}

fn evidence_rows(
    tx: &Connection,
    input: &ExtractInput,
    edge: &str,
    quotes: &[QuoteRef],
    basis: &str,
) -> CognitionResult<()> {
    let validated = crate::cognition::graph::plan::validate_quotes_for_apply(input, quotes)?;
    for quote in resolve_quotes(tx, input, &validated)? {
        tx.execute("INSERT OR IGNORE INTO edge_evidence(edge_id,chunk_source_id,basis,extraction_version) VALUES(?1,?2,?3,'memory-extract-v3')",params![edge,quote.source_id,basis]).map_err(db_error)?;
    }
    Ok(())
}
fn hash(value: Vec<Value>) -> CognitionResult<String> {
    Ok(crate::cognition::sources::projection_hash_for_graph(value)?)
}
fn invalid_ref() -> CognitionError {
    CognitionError::new("memory_extract_invalid_ref", "memory_extract_invalid_ref")
}
fn candidate_changed() -> CognitionError {
    CognitionError::new(
        "memory_extract_candidate_changed",
        "memory_extract_candidate_changed",
    )
}
fn json_error(error: impl std::fmt::Display) -> CognitionError {
    CognitionError::new("memory_extract_invalid_json", error.to_string())
}
