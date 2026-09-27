//! Recent canonical-message disambiguation; canonical IDs are supplied by Sources.

use std::collections::HashSet;

use rusqlite::{Connection, params_from_iter, types::Value};

use crate::cognition::{
    CognitionResult,
    recall::{Channel, RankedCandidate, RecallRequest},
};

use super::super::{db_error, scope};
use super::json_error;

pub(super) fn select(
    db: &Connection,
    input: &RecallRequest,
    recent_message_ids: &[String],
) -> CognitionResult<Vec<RankedCandidate>> {
    if recent_message_ids.is_empty() {
        return Ok(Vec::new());
    }
    let claim = scope::claim(input, "e", "id");
    let source = scope::source(input, "s", "c");
    let sql = format!(
        "SELECT m.node_id
         FROM memory_evidence m
         JOIN memory_chunk_sources s ON s.source_id=m.source_id
         JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision
         JOIN memory_nodes e ON e.id=m.node_id
         WHERE s.conversation_message_id IN (SELECT value FROM json_each(?))
           AND {} AND {}
         GROUP BY m.node_id
         ORDER BY MAX(s.observed_at) DESC,m.node_id",
        claim.sql, source.sql
    );
    let mut args = vec![Value::Text(
        serde_json::to_string(recent_message_ids).map_err(json_error)?,
    )];
    args.extend(claim.args);
    args.extend(source.args);
    let mut statement = db.prepare(&sql).map_err(db_error)?;
    let mut node_ids = Vec::new();
    let mut seen = HashSet::new();
    for row in statement
        .query_map(params_from_iter(args), |row| row.get::<_, String>(0))
        .map_err(db_error)?
    {
        let node_id = row.map_err(db_error)?;
        if seen.insert(node_id.clone()) && node_ids.len() < 4 {
            node_ids.push(node_id);
        }
    }
    let channels = node_ids
        .into_iter()
        .enumerate()
        .map(|(index, node_id)| RankedCandidate {
            node_id,
            channel: Channel::Context,
            rank: index + 1,
            score: 1.0,
        })
        .collect();
    Ok(channels)
}
