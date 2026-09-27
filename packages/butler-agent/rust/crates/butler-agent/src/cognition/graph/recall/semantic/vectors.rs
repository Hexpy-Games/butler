//! Second pinned-graph eligibility filter for current-generation vector nodes.

use std::collections::HashSet;

use rusqlite::{Connection, params_from_iter, types::Value};

use crate::cognition::{
    CognitionResult,
    recall::{Channel, RankedCandidate, RecallRequest, RecallVectorMatch},
};

use super::super::{db_error, scope};
use super::json_error;

pub(super) fn select(
    db: &Connection,
    input: &RecallRequest,
    hits: &[RecallVectorMatch],
) -> CognitionResult<Vec<RankedCandidate>> {
    let mut seen = HashSet::new();
    let ids = hits
        .iter()
        .filter_map(|hit| {
            seen.insert(hit.owner_id.as_str())
                .then_some(hit.owner_id.as_str())
        })
        .take(64)
        .collect::<Vec<_>>();
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let claim = scope::claim(input, "e", "id");
    let source = scope::source(input, "s", "c");
    let sql = format!(
        "SELECT DISTINCT m.node_id
         FROM memory_evidence m
         JOIN memory_nodes e ON e.id=m.node_id
         JOIN memory_chunk_sources s ON s.source_id=m.source_id
         JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision
         WHERE m.node_id IN (SELECT value FROM json_each(?))
           AND {} AND {}",
        claim.sql, source.sql
    );
    let mut args = vec![Value::Text(
        serde_json::to_string(&ids).map_err(json_error)?,
    )];
    args.extend(claim.args);
    args.extend(source.args);
    let mut statement = db.prepare(&sql).map_err(db_error)?;
    let eligible = statement
        .query_map(params_from_iter(args), |row| row.get::<_, String>(0))
        .map_err(db_error)?
        .collect::<Result<HashSet<_>, _>>()
        .map_err(db_error)?;
    Ok(hits
        .iter()
        .filter(|hit| eligible.contains(&hit.owner_id))
        .take(64)
        .map(|hit| RankedCandidate {
            node_id: hit.owner_id.clone(),
            channel: Channel::Vector,
            rank: hit.rank,
            score: 1.0 / (1.0 + hit.distance.max(0.0)),
        })
        .collect())
}
