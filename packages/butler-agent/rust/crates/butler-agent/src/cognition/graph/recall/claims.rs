//! Evidence-bound graph claim projections; no graph statement is public without sources.

mod interpretations;
mod requirements;

use std::collections::HashSet;

use rusqlite::{Connection, OptionalExtension, params_from_iter, types::Value};

use crate::cognition::{
    CognitionResult,
    recall::{RecallInterpretation, RecallRequest, RecallRequirement},
};

use super::{RecallMention, db_error, scope};

pub(super) fn node_type(db: &Connection, node_id: &str) -> CognitionResult<Option<String>> {
    db.query_row(
        "SELECT type FROM memory_nodes WHERE id=?",
        [node_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(db_error)
}

pub(super) fn matched_summary(
    db: &Connection,
    input: &RecallRequest,
    episode_id: &str,
    matched_node_id: Option<&str>,
    mentions: &[RecallMention],
    surviving: &HashSet<String>,
) -> CognitionResult<Option<String>> {
    let Some(matched) = matched_node_id else {
        return Ok(None);
    };
    let matched_sources = mentions
        .iter()
        .filter(|mention| mention.node_id == matched && surviving.contains(&mention.source_id))
        .map(|mention| mention.source_id.clone())
        .collect::<HashSet<_>>();
    if matched_sources.is_empty() || surviving.is_empty() {
        return Ok(None);
    }
    let matched_is_claim = node_type(db, matched)?.is_some_and(|kind| {
        matches!(
            kind.as_str(),
            "preference" | "goal" | "constraint" | "decision" | "memory_atom"
        )
    });
    let validity = scope::claim(input, "e", "id");
    let source = scope::source(input, "s", "c");
    let matched_filter = if matched_is_claim { "AND e.id=?" } else { "" };
    let sql = format!(
        r"
        SELECT (SELECT statement FROM memory_claims WHERE node_id=e.id)
        FROM memory_evidence m
        JOIN memory_nodes e ON e.id=m.node_id
        JOIN memory_chunk_sources s ON s.source_id=m.source_id
        JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id
          AND c.current_revision=s.revision
        WHERE m.episode_id=? AND m.source_id IN ({})
          AND NOT EXISTS (
            SELECT 1 FROM memory_evidence dependency
            WHERE dependency.node_id=e.id AND dependency.source_id NOT IN ({})
          )
          AND e.type IN ('preference','goal','constraint','decision','memory_atom')
          {matched_filter} AND {} AND {}
        ORDER BY CASE WHEN e.id=? THEN 0 ELSE 1 END,m.source_id,e.id LIMIT 1
    ",
        scope::placeholders(matched_sources.len()),
        scope::placeholders(surviving.len()),
        validity.sql,
        source.sql
    );
    let mut matched_sources = matched_sources.into_iter().collect::<Vec<_>>();
    matched_sources.sort();
    let mut all_sources = surviving.iter().cloned().collect::<Vec<_>>();
    all_sources.sort();
    let mut args = vec![Value::Text(episode_id.into())];
    args.extend(matched_sources.into_iter().map(Value::Text));
    args.extend(all_sources.into_iter().map(Value::Text));
    if matched_is_claim {
        args.push(Value::Text(matched.into()));
    }
    args.extend(validity.args);
    args.extend(source.args);
    args.push(Value::Text(matched.into()));
    let result: Option<String> = db
        .query_row(&sql, params_from_iter(args), |row| row.get(0))
        .optional()
        .map_err(db_error)?
        .flatten();
    Ok(result.filter(|statement| !statement.is_empty()))
}

pub(super) fn result_requirements(
    db: &Connection,
    input: &RecallRequest,
    refs: &[(String, String)],
) -> CognitionResult<Vec<RecallRequirement>> {
    requirements::requirements(db, input, refs)
}

pub(super) fn result_interpretations(
    db: &Connection,
    input: &RecallRequest,
    refs: &[(String, String)],
    parse_date: impl Fn(&str) -> f64,
) -> CognitionResult<Vec<RecallInterpretation>> {
    interpretations::interpretations(db, input, refs, parse_date)
}
