//! Source-qualified episode mentions and supporting source leaves.

use rusqlite::{Connection, params_from_iter, types::Value};

use crate::cognition::{CognitionResult, recall::RecallRequest};

use super::{db_error, scope};

#[derive(Clone, Debug)]
pub(in crate::cognition) struct RecallMention {
    pub node_id: String,
    pub source_id: String,
    pub episode_id: String,
    pub supports: bool,
}

pub(super) fn for_nodes(
    db: &Connection,
    input: &RecallRequest,
    node_ids: &[String],
) -> CognitionResult<Vec<RecallMention>> {
    select_mentions(db, input, node_ids, "m.node_id")
}

pub(super) fn for_episodes(
    db: &Connection,
    input: &RecallRequest,
    episode_ids: &[String],
) -> CognitionResult<Vec<RecallMention>> {
    select_mentions(db, input, episode_ids, "m.episode_id")
}

fn select_mentions(
    db: &Connection,
    input: &RecallRequest,
    ids: &[String],
    column: &str,
) -> CognitionResult<Vec<RecallMention>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let claim = scope::claim(input, "e", "id");
    let source = scope::source(input, "s", "c");
    let event = scope::event_episode(input, "m.episode_id");
    let sql = format!(
        "SELECT DISTINCT m.node_id,m.source_id,m.episode_id
         FROM memory_evidence m
         JOIN memory_nodes e ON e.id=m.node_id
         JOIN memory_chunk_sources s ON s.source_id=m.source_id
         JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision
         WHERE {column} IN ({}) AND {} AND {} {}
         ORDER BY m.episode_id,m.source_id",
        scope::placeholders(ids.len()),
        claim.sql,
        source.sql,
        event.sql
    );
    let mut args = ids.iter().cloned().map(Value::Text).collect::<Vec<_>>();
    args.extend(claim.args);
    args.extend(source.args);
    args.extend(event.args);
    let mut statement = db.prepare(&sql).map_err(db_error)?;
    statement
        .query_map(params_from_iter(args), |row| {
            Ok(RecallMention {
                node_id: row.get(0)?,
                source_id: row.get(1)?,
                episode_id: row.get(2)?,
                supports: false,
            })
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)
}

pub(super) fn episode_sources(
    db: &Connection,
    input: &RecallRequest,
    episode_ids: &[String],
) -> CognitionResult<Vec<RecallMention>> {
    if episode_ids.is_empty() {
        return Ok(Vec::new());
    }
    let source = scope::source(input, "s", "c");
    let event = scope::event_episode(input, "s.episode_id");
    let sql = format!(
        "SELECT s.source_id,s.episode_id FROM memory_source_leaves s
         JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision
         WHERE s.episode_id IN ({}) AND {} {}
         ORDER BY s.observed_at DESC,s.source_id",
        scope::placeholders(episode_ids.len()),
        source.sql,
        event.sql
    );
    let mut args = episode_ids
        .iter()
        .cloned()
        .map(Value::Text)
        .collect::<Vec<_>>();
    args.extend(source.args);
    args.extend(event.args);
    let mut statement = db.prepare(&sql).map_err(db_error)?;
    statement
        .query_map(params_from_iter(args), |row| {
            let source_id = row.get(0)?;
            let episode_id: String = row.get(1)?;
            Ok(RecallMention {
                node_id: episode_id.clone(),
                source_id,
                episode_id,
                supports: true,
            })
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)
}
