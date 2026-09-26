use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, params_from_iter, types::Value};

use crate::cognition::{
    CognitionResult,
    recall::{InterpretationStatus, RecallInterpretation, RecallRequest},
};

use super::super::{db_error, scope};

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
    let sql = format!(
        r"
        SELECT DISTINCT c.node_id FROM memory_claims c
        JOIN memory_evidence e ON e.node_id=c.node_id
        WHERE e.source_id IN ({}) ORDER BY c.node_id LIMIT 8
    ",
        scope::placeholders(ids.len())
    );
    let mut statement = db.prepare(&sql).map_err(db_error)?;
    let nodes = statement
        .query_map(
            params_from_iter(ids.iter().cloned().map(Value::Text)),
            |row| row.get::<_, String>(0),
        )
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
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
        let (statement, speech_act, basis, source_class, authority, valid_from, valid_to): (
            String,
            String,
            String,
            String,
            String,
            Option<String>,
            Option<String>,
        ) = claims
            .query_row([&node_id], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
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
        let mut status = if valid_from
            .as_deref()
            .is_some_and(|from| parse_date(from) > parse_date(&input.as_of))
            || valid_to
                .as_deref()
                .is_some_and(|to| parse_date(to) <= parse_date(&input.as_of))
        {
            InterpretationStatus::Historical
        } else {
            InterpretationStatus::Recorded
        };
        let mut args = vec![Value::Text(node_id.clone())];
        args.extend(ids.iter().cloned().map(Value::Text));
        let relations = changes
            .query_map(params_from_iter(args), |row| row.get::<_, String>(0))
            .map_err(db_error)?
            .collect::<Result<HashSet<_>, _>>()
            .map_err(db_error)?;
        if relations.contains("refines") {
            status = InterpretationStatus::Refined;
        }
        if relations.contains("contradicts") {
            status = InterpretationStatus::Conflicted;
        }
        if relations.contains("supersedes") {
            status = InterpretationStatus::Superseded;
        }
        output.push(RecallInterpretation {
            node_ref: node_id,
            statement,
            speech_act,
            basis,
            source_class,
            authority,
            source_refs,
            support_complete: true,
            status,
        });
    }
    Ok(output)
}
