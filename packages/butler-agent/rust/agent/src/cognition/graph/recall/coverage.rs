//! Registered graph/vector state and canonical inventory coverage.

use rusqlite::{Connection, OptionalExtension, params, params_from_iter, types::Value};

use crate::cognition::{CognitionResult, recall::RecallRequest, sources::CanonicalInventory};

use super::{db_error, scope};

#[derive(Debug)]
pub(in crate::cognition) struct ProjectionCoverage {
    pub pending: bool,
    pub codes: Vec<String>,
}

pub(super) fn graph(
    db: &Connection,
    input: &RecallRequest,
    inventory: &CanonicalInventory,
) -> CognitionResult<ProjectionCoverage> {
    let source = scope::source(input, "s", "c");
    let sql=format!(
        "SELECT COUNT(DISTINCT j.job_id) FROM memory_projection_jobs j
         JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision
         JOIN memory_chunk_sources s ON s.episode_id=c.memory_chunk_id AND s.revision=c.current_revision
         WHERE json_extract(j.semantic_graph_state,'$.state')!='complete' AND {}",
        source.sql
    );
    let registered_incomplete = db
        .query_row(&sql, params_from_iter(source.args), |row| {
            row.get::<_, i64>(0)
        })
        .map_err(db_error)?
        > 0;
    let mut missing = false;
    let mut statement = db
        .prepare(
            "SELECT 1 FROM memory_chunks c JOIN memory_projection_jobs j
         ON j.episode_id=c.memory_chunk_id AND j.revision=c.current_revision
         WHERE c.memory_chunk_id=?1 AND c.current_revision=?2
           AND json_extract(j.semantic_graph_state,'$.state')='complete' LIMIT 1",
        )
        .map_err(db_error)?;
    for entry in &inventory.entries {
        if statement
            .query_row(params![entry.episode_id, entry.revision], |row| {
                row.get::<_, i64>(0)
            })
            .optional()
            .map_err(db_error)?
            .is_none()
        {
            missing = true;
            break;
        }
    }
    let mut codes = Vec::new();
    if registered_incomplete || missing {
        codes.push("ingestion_pending".into());
    }
    if !inventory.available {
        codes.push("canonical_source_unavailable".into());
    }
    if inventory.partial {
        codes.push("ingestion_inventory_partial".into());
    }
    Ok(ProjectionCoverage {
        pending: registered_incomplete || missing || inventory.partial,
        codes,
    })
}

pub(super) fn vector_incomplete(
    db: &Connection,
    input: &RecallRequest,
    generation: &str,
) -> CognitionResult<bool> {
    let source = scope::source(input, "s", "c");
    let sql=format!(
        "SELECT COUNT(DISTINCT u.unit_id) FROM memory_vector_units u
         JOIN memory_projection_jobs j ON j.job_id=u.job_id
         JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision
         JOIN memory_chunk_sources s ON s.episode_id=c.memory_chunk_id AND s.revision=c.current_revision
         WHERE j.generation=? AND u.state!='complete' AND {}",
        source.sql
    );
    let mut args = vec![Value::Text(generation.to_owned())];
    args.extend(source.args);
    Ok(db
        .query_row(&sql, params_from_iter(args), |row| row.get::<_, i64>(0))
        .map_err(db_error)?
        > 0)
}
