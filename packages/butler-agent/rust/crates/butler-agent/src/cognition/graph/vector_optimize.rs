//! Revision-aware vector pruning evidence, read from the generation graph.

use std::collections::HashSet;

use rusqlite::Connection;
use serde_json::Value;

use super::db_error;
use crate::cognition::CognitionResult;

const ELIGIBLE: &str = "
    SELECT u.receipt_json FROM memory_vector_units u
    JOIN memory_projection_jobs j ON j.job_id=u.job_id
    JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id
    WHERE j.revision<>c.current_revision AND u.state='complete' AND u.receipt_json IS NOT NULL
      AND json_extract(j.semantic_graph_state,'$.state')='complete'
      AND EXISTS (
        SELECT 1 FROM memory_projection_jobs current_job
        WHERE current_job.episode_id=j.episode_id AND current_job.revision=c.current_revision
          AND json_extract(current_job.semantic_graph_state,'$.state')='complete'
          AND CASE u.record_kind
            WHEN 'episode' THEN json_extract(current_job.episode_vectors_state,'$.state')
            WHEN 'node' THEN json_extract(current_job.node_vectors_state,'$.state')
          END='complete'
          AND NOT EXISTS (
            SELECT 1 FROM memory_vector_units current_unit
            WHERE current_unit.job_id=current_job.job_id AND current_unit.record_kind=u.record_kind
              AND current_unit.state NOT IN ('complete','superseded')
          )
      )";

const LIVE: &str = "
    SELECT u.receipt_json FROM memory_vector_units u
    JOIN memory_projection_jobs j ON j.job_id=u.job_id
    JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision
    WHERE u.receipt_json IS NOT NULL AND u.state!='superseded'";

fn receipt_keys(connection: &Connection, sql: &str) -> CognitionResult<HashSet<String>> {
    let mut statement = connection.prepare(sql).map_err(db_error)?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(db_error)?;
    let mut keys = HashSet::new();
    for row in rows {
        let receipt = row.map_err(db_error)?;
        let Ok(Value::Object(fields)) = serde_json::from_str::<Value>(&receipt) else {
            continue;
        };
        if let Some(Value::Array(values)) = fields.get("vector_keys") {
            for value in values {
                if let Value::String(key) = value
                    && !key.is_empty()
                {
                    keys.insert(key.clone());
                }
            }
        }
    }
    Ok(keys)
}

/// Initial selection and write-gate revalidation use the same SQL contract.
pub(super) fn removable_keys(connection: &Connection) -> CognitionResult<Vec<String>> {
    let eligible = receipt_keys(connection, ELIGIBLE)?;
    let live = receipt_keys(connection, LIVE)?;
    let mut keys: Vec<_> = eligible.difference(&live).cloned().collect();
    keys.sort();
    Ok(keys)
}
