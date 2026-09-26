use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

use super::super::db_error;
use super::{TypedRegistrationInput, source_changed};
use crate::cognition::{
    CognitionError, CognitionResult, CognitionSourceRow, MEMORY_SOURCE_WINDOW_BYTES, sources,
};

pub(super) fn existing_job(
    connection: &Connection,
    plan: &sources::TypedPlan,
    completion_id: Option<&str>,
) -> CognitionResult<Option<String>> {
    let mut statement = connection
        .prepare(
            "SELECT j.job_id,j.observed_completion_job_ids FROM memory_projection_jobs j \
             JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision \
             WHERE j.episode_id=?1 AND j.revision=?2",
        )
        .map_err(db_error)?;
    let rows = statement
        .query_map(params![plan.episode_id, plan.revision], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    drop(statement);
    if rows.len() > 1 {
        return Err(CognitionError::new(
            "memory_projection_duplicate_revision",
            "memory_projection_duplicate_revision",
        ));
    }
    let Some((job_id, encoded)) = rows.into_iter().next() else {
        return Ok(None);
    };
    let mut ids = serde_json::from_str::<Vec<String>>(&encoded).map_err(json_error)?;
    if let Some(id) = completion_id.filter(|id| !id.is_empty())
        && !ids.iter().any(|value| value == id)
    {
        ids.push(id.to_owned());
        ids.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
        connection
            .execute(
                "UPDATE memory_projection_jobs SET observed_completion_job_ids=?1 WHERE job_id=?2",
                params![json_string_array(&ids)?, job_id],
            )
            .map_err(db_error)?;
    }
    Ok(Some(job_id))
}

pub(super) fn prior_source_ids(
    connection: &Connection,
    episode_id: &str,
    revision: Option<&str>,
) -> CognitionResult<Vec<String>> {
    let Some(revision) = revision else {
        return Ok(Vec::new());
    };
    let mut statement = connection
        .prepare(
            "SELECT source_id FROM memory_chunk_sources \
             WHERE episode_id=?1 AND revision=?2 ORDER BY source_id",
        )
        .map_err(db_error)?;
    statement
        .query_map(params![episode_id, revision], |row| row.get(0))
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)
}

pub(super) fn upsert_chunk(
    connection: &Connection,
    input: &TypedRegistrationInput<'_>,
    now: &str,
) -> CognitionResult<()> {
    connection
        .execute(
            "INSERT INTO memory_chunks(memory_chunk_id,source_key,current_revision,conversation_session_id,conversation_turn_id,conversation_start,conversation_end,project_id,origin_kind,status,source_hash,created_at,updated_at) \
             VALUES(?1,?2,?3,?4,NULL,?5,?5,?6,?7,'active',?8,?9,?9) \
             ON CONFLICT(source_key) DO UPDATE SET \
               current_revision=excluded.current_revision, \
               conversation_session_id=excluded.conversation_session_id, \
               conversation_turn_id=NULL, conversation_start=excluded.conversation_start, \
               conversation_end=excluded.conversation_end, project_id=excluded.project_id, \
               origin_kind=excluded.origin_kind, status='active', source_hash=excluded.source_hash, \
               updated_at=excluded.updated_at, \
               summary=CASE WHEN memory_chunks.current_revision!=excluded.current_revision THEN '' ELSE memory_chunks.summary END, \
               summary_status=CASE WHEN memory_chunks.current_revision!=excluded.current_revision THEN 'pending' ELSE memory_chunks.summary_status END",
            params![
                input.plan.episode_id,
                input.plan.source_key,
                input.plan.revision,
                input.plan.session_id,
                input.plan.observed_at,
                input.plan.project_id,
                input.plan.source_kind,
                input.plan.content_hash,
                now,
            ],
        )
        .map_err(db_error)?;
    Ok(())
}

pub(super) fn insert_source(
    connection: &Connection,
    row: &CognitionSourceRow,
) -> CognitionResult<()> {
    connection
        .execute(
            "INSERT OR IGNORE INTO memory_chunk_sources(source_id,episode_id,revision,source_kind,conversation_session_id,conversation_message_id,part_id,scalar_pointer,byte_start,byte_end,content_hash,role,origin_kind,observed_at,basis) \
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
            params![
                row.source_id,
                row.episode_id,
                row.revision,
                row.source_kind,
                row.conversation_session_id,
                row.conversation_message_id,
                row.part_id,
                row.scalar_pointer,
                row.byte_start,
                row.byte_end,
                row.content_hash,
                row.role,
                row.origin_kind,
                row.observed_at,
                row.basis,
            ],
        )
        .map_err(db_error)?;
    let stored = connection
        .query_row(
            "SELECT source_id,episode_id,revision,source_kind,conversation_session_id,conversation_message_id,part_id,scalar_pointer,byte_start,byte_end,content_hash,role,origin_kind,observed_at,basis \
             FROM memory_chunk_sources WHERE source_id=?1",
            [&row.source_id],
            source_row,
        )
        .optional()
        .map_err(db_error)?;
    if stored.as_ref() != Some(row) {
        return Err(source_changed());
    }
    Ok(())
}

pub(super) fn insert_job(
    connection: &Connection,
    input: &TypedRegistrationInput<'_>,
    source_count: usize,
    now: &str,
) -> CognitionResult<()> {
    let mut ids = Vec::new();
    if let Some(id) = input.completion_id.filter(|value| !value.is_empty()) {
        ids.push(id.to_owned());
    }
    let complete = json!({
        "state":"complete",
        "completed_units":source_count,
        "total_units":source_count
    });
    let pending = json!({"state":"pending","blocked_by":null});
    connection
        .execute(
            "INSERT INTO memory_projection_jobs(job_id,episode_id,revision,extraction_version,generation,extraction_model,reasoning_effort,observed_completion_job_ids,source_state,semantic_graph_state,episode_vectors_state,node_vectors_state,hot_cache_state,created_at) \
             VALUES(?1,?2,?3,'memory-extract-v3',?4,?5,?6,?7,?8,?9,?9,?9,?9,?10) \
             ON CONFLICT(episode_id,revision,extraction_version) DO UPDATE SET observed_completion_job_ids=excluded.observed_completion_job_ids",
            params![
                input.plan.job_id,
                input.plan.episode_id,
                input.plan.revision,
                input.generation_id,
                input.extraction_model,
                input.reasoning_effort,
                json_string_array(&ids)?,
                crate::json::stringify(&complete).map_err(json_error)?,
                crate::json::stringify(&pending).map_err(json_error)?,
                now,
            ],
        )
        .map_err(db_error)?;
    Ok(())
}

pub(super) fn insert_windows(
    connection: &Connection,
    plan: &sources::TypedPlan,
    registered: &[String],
) -> CognitionResult<()> {
    for (ordinal, source_id) in registered.iter().enumerate() {
        let (start, end) = connection
            .query_row(
                "SELECT byte_start,byte_end FROM memory_chunk_sources WHERE source_id=?1",
                [source_id],
                |row| Ok((row.get::<_, f64>(0)?, row.get::<_, f64>(1)?)),
            )
            .optional()
            .map_err(db_error)?
            .ok_or_else(source_changed)?;
        if end - start > MEMORY_SOURCE_WINDOW_BYTES {
            return Err(CognitionError::new(
                "memory_extract_source_window_exceeds_budget",
                "memory_extract_source_window_exceeds_budget",
            ));
        }
        let window_ref = sources::projection_hash_for_graph(vec![
            Value::String("memory-window".into()),
            Value::String(plan.revision.clone()),
            Value::String(source_id.clone()),
        ])?;
        let refs = vec![source_id.clone()];
        connection
            .execute(
                "INSERT INTO memory_projection_windows(window_ref,job_id,ordinal,source_refs_json,state,error_code) \
                 VALUES(?1,?2,?3,?4,'pending',NULL)",
                params![
                    window_ref,
                    plan.job_id,
                    i64::try_from(ordinal).unwrap_or(i64::MAX),
                    json_string_array(&refs)?,
                ],
            )
            .map_err(db_error)?;
    }
    Ok(())
}

pub(super) fn replacement_source_refs(
    connection: &Connection,
    source_id: &str,
) -> CognitionResult<Vec<String>> {
    let leaves = expand(connection, source_id)?;
    Ok(if leaves.len() == 1 && leaves[0] == source_id {
        Vec::new()
    } else {
        leaves
    })
}

fn expand(connection: &Connection, source_id: &str) -> CognitionResult<Vec<String>> {
    let encoded = connection
        .query_row(
            "SELECT child_source_ids_json FROM memory_source_split_parents WHERE source_id=?1",
            [source_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(db_error)?;
    let Some(encoded) = encoded else {
        return Ok(vec![source_id.to_owned()]);
    };
    let children = serde_json::from_str::<Vec<String>>(&encoded).map_err(json_error)?;
    let mut leaves = Vec::new();
    for child in children {
        leaves.extend(expand(connection, &child)?);
    }
    Ok(leaves)
}

fn source_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CognitionSourceRow> {
    Ok(CognitionSourceRow {
        source_id: row.get(0)?,
        episode_id: row.get(1)?,
        revision: row.get(2)?,
        source_kind: row.get(3)?,
        conversation_session_id: row.get(4)?,
        conversation_message_id: row.get(5)?,
        part_id: row.get(6)?,
        scalar_pointer: row.get(7)?,
        byte_start: row.get(8)?,
        byte_end: row.get(9)?,
        content_hash: row.get(10)?,
        role: row.get(11)?,
        origin_kind: row.get(12)?,
        observed_at: row.get(13)?,
        basis: row.get(14)?,
    })
}

fn json_string_array(values: &[String]) -> CognitionResult<String> {
    crate::json::stringify(&Value::Array(
        values.iter().cloned().map(Value::String).collect(),
    ))
    .map_err(json_error)
}

fn json_error(error: impl std::fmt::Display) -> CognitionError {
    CognitionError::new("memory_graph_unavailable", error.to_string())
}
