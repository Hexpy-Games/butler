//! Recorded interpretations: claims whose every evidence source was returned,
//! with a status from their validity window and later corrections.

use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, Statement, params_from_iter, types::Value as SqlValue};

use crate::cognition::{
    CognitionResult,
    recall::{InterpretationStatus, RecallInterpretation, RecallRequest},
};

use super::super::{db_error, scope};

/// One claim row.
struct ClaimRow {
    statement: String,
    speech_act: String,
    basis: String,
    source_class: String,
    authority: String,
    valid_from: Option<String>,
    valid_to: Option<String>,
}

/// Up to eight claims supported by the returned sources `refs`
/// (`(source id, handle)` pairs).
pub(super) fn interpretations(
    db: &Connection,
    input: &RecallRequest,
    refs: &[(String, String)],
    parse_date: impl Fn(&str) -> f64,
) -> CognitionResult<Vec<RecallInterpretation>> {
    if refs.is_empty() {
        return Ok(Vec::new());
    }
    let refs = refs.iter().cloned().collect::<HashMap<_, _>>();
    let ids = refs.keys().cloned().collect::<Vec<_>>();
    let nodes = claim_nodes(db, &ids)?;
    let mut claims = db
        .prepare(
            "SELECT statement,speech_act,basis,source_class,authority,valid_from,valid_to
         FROM memory_claims WHERE node_id=?",
        )
        .map_err(db_error)?;
    let mut dependencies = db
        .prepare("SELECT source_id FROM memory_evidence WHERE node_id=?")
        .map_err(db_error)?;
    let changes_sql = format!(
        r"
        SELECT DISTINCT e.rel_type FROM edges e
        JOIN edge_evidence ee ON ee.edge_id=e.edge_id
        JOIN memory_chunk_sources s ON s.source_id=ee.chunk_source_id
        JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id
          AND c.current_revision=s.revision
        WHERE e.target_node_id=? AND e.status='active' AND c.status='active'
          AND ee.chunk_source_id IN ({})
          AND e.rel_type IN ('supersedes','contradicts','refines')
    ",
        scope::placeholders(ids.len())
    );
    let mut changes = db.prepare(&changes_sql).map_err(db_error)?;
    let mut output = Vec::new();
    for node_id in nodes {
        let claim = claims
            .query_row([&node_id], |row| {
                Ok(ClaimRow {
                    statement: row.get(0)?,
                    speech_act: row.get(1)?,
                    basis: row.get(2)?,
                    source_class: row.get(3)?,
                    authority: row.get(4)?,
                    valid_from: row.get(5)?,
                    valid_to: row.get(6)?,
                })
            })
            .map_err(db_error)?;
        let dependent = dependencies
            .query_map([&node_id], |row| row.get::<_, String>(0))
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        let source_refs = dependent
            .iter()
            .filter_map(|id| refs.get(id).cloned())
            .collect::<Vec<_>>();
        if source_refs.len() != dependent.len() {
            continue;
        }
        let relations = corrections(&mut changes, &node_id, &ids)?;
        let status = interpretation_status(&claim, &relations, &parse_date, &input.as_of);
        output.push(RecallInterpretation {
            node_ref: node_id,
            statement: claim.statement,
            speech_act: claim.speech_act,
            basis: claim.basis,
            source_class: claim.source_class,
            authority: claim.authority,
            source_refs,
            support_complete: true,
            status,
        });
    }
    Ok(output)
}

/// Claim nodes with evidence among `ids`.
fn claim_nodes(db: &Connection, ids: &[String]) -> CognitionResult<Vec<String>> {
    let sql = format!(
        r"
        SELECT DISTINCT c.node_id FROM memory_claims c
        JOIN memory_evidence e ON e.node_id=c.node_id
        WHERE e.source_id IN ({}) ORDER BY c.node_id LIMIT 8
    ",
        scope::placeholders(ids.len())
    );
    let mut statement = db.prepare(&sql).map_err(db_error)?;
    statement
        .query_map(
            params_from_iter(ids.iter().cloned().map(SqlValue::Text)),
            |row| row.get::<_, String>(0),
        )
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)
}

/// Correction relations targeting the claim from current returned sources.
fn corrections(
    changes: &mut Statement<'_>,
    node_id: &str,
    ids: &[String],
) -> CognitionResult<HashSet<String>> {
    let mut args = vec![SqlValue::Text(node_id.to_owned())];
    args.extend(ids.iter().cloned().map(SqlValue::Text));
    changes
        .query_map(params_from_iter(args), |row| row.get::<_, String>(0))
        .map_err(db_error)?
        .collect::<Result<HashSet<_>, _>>()
        .map_err(db_error)
}

/// Supersession wins over contradiction, which wins over refinement; an
/// uncorrected claim is historical outside its validity window.
fn interpretation_status(
    claim: &ClaimRow,
    relations: &HashSet<String>,
    parse_date: impl Fn(&str) -> f64,
    as_of: &str,
) -> InterpretationStatus {
    if relations.contains("supersedes") {
        return InterpretationStatus::Superseded;
    }
    if relations.contains("contradicts") {
        return InterpretationStatus::Conflicted;
    }
    if relations.contains("refines") {
        return InterpretationStatus::Refined;
    }
    let now = parse_date(as_of);
    let not_yet = claim
        .valid_from
        .as_deref()
        .is_some_and(|from| parse_date(from) > now);
    let ended = claim
        .valid_to
        .as_deref()
        .is_some_and(|to| parse_date(to) <= now);
    if not_yet || ended {
        InterpretationStatus::Historical
    } else {
        InterpretationStatus::Recorded
    }
}
