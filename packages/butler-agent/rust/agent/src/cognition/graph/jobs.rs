use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use super::db_error;
use crate::cognition::{
    CognitionError, CognitionResult, ConversationSourceNotice, assert_conversation_source_current,
};
use crate::conversation::ConversationSourceReader;

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct GraphProgress {
    pub job_id: String,
    pub observed_completion_job_ids: Vec<String>,
    pub episode_id: String,
    pub revision: String,
    pub extraction_version: String,
    pub generation: String,
    pub source: Value,
    pub semantic_graph: Value,
    pub episode_vectors: Value,
    pub node_vectors: Value,
    pub hot_cache: Value,
    pub outcome: String,
}

#[derive(Clone, Debug)]
pub(in crate::cognition) struct PendingSemanticJob {
    pub job_id: String,
    pub session_id: Option<String>,
    pub source_key: String,
    pub source_hash: String,
    pub extraction_version: String,
}

#[derive(Clone, Debug, Default)]
pub(in crate::cognition) struct CatchupCursors {
    pub outcome: Option<String>,
    pub message: Option<String>,
}

pub(super) fn catchup_cursors(connection: &Connection) -> CognitionResult<CatchupCursors> {
    let read = |key| -> CognitionResult<Option<String>> {
        connection
            .query_row(
                "SELECT value FROM memory_state WHERE key=?1",
                [key],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map(|value| value.filter(|item| !item.is_empty()))
            .map_err(db_error)
    };
    Ok(CatchupCursors {
        outcome: read("canonical_catchup_outcome_cursor")?,
        message: read("canonical_catchup_message_cursor")?,
    })
}

pub(super) fn save_catchup_cursors(
    connection: &mut Connection,
    cursors: &CatchupCursors,
) -> CognitionResult<()> {
    let transaction = connection.transaction().map_err(db_error)?;
    for (key, value) in [
        (
            "canonical_catchup_outcome_cursor",
            cursors.outcome.as_deref().unwrap_or(""),
        ),
        (
            "canonical_catchup_message_cursor",
            cursors.message.as_deref().unwrap_or(""),
        ),
    ] {
        transaction.execute(
            "INSERT INTO memory_state(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, value],
        ).map_err(db_error)?;
    }
    transaction.commit().map_err(db_error)
}

pub(super) fn pending_semantic(
    connection: &Connection,
    now: &str,
) -> CognitionResult<Option<PendingSemanticJob>> {
    connection.query_row(
        "SELECT j.job_id,c.conversation_session_id,c.source_key,c.source_hash,j.extraction_version
         FROM memory_projection_jobs j
         JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision
         WHERE EXISTS (
           SELECT 1 FROM memory_projection_windows w
           WHERE w.job_id=j.job_id AND w.state IN ('pending','planned') AND w.owner_nonce IS NULL
             AND (w.state='planned' OR w.output_json IS NOT NULL OR (
               SELECT COUNT(DISTINCT a.invocation_ref) FROM memory_projection_attempts a
               WHERE a.window_ref=w.window_ref AND a.provider_invoked=1
                 AND a.recovery_revision IS w.recovery_revision) < 3)
             AND (w.next_attempt_at IS NULL OR w.next_attempt_at<=?1))
         ORDER BY j.last_served_at IS NOT NULL,j.last_served_at,j.created_at,j.job_id LIMIT 1",
        [now],
        |row| Ok(PendingSemanticJob {
            job_id: row.get(0)?, session_id: row.get(1)?, source_key: row.get(2)?,
            source_hash: row.get(3)?, extraction_version: row.get(4)?,
        }),
    ).optional().map_err(db_error)
}

pub(super) fn replay(
    connection: &mut Connection,
    canonical: &ConversationSourceReader,
    notice: ConversationSourceNotice<'_>,
    episode_id: &str,
    revision: &str,
    completion_id: Option<&str>,
    now: &str,
) -> CognitionResult<Option<String>> {
    let tx = connection.transaction().map_err(db_error)?;
    assert_conversation_source_current(canonical, notice, revision, now)?;
    let mut statement = tx
        .prepare(
            "SELECT j.job_id,j.observed_completion_job_ids FROM memory_projection_jobs j \
         JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision \
         WHERE j.episode_id=?1 AND j.revision=?2",
        )
        .map_err(db_error)?;
    let rows = statement
        .query_map(params![episode_id, revision], |row| {
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
        tx.commit().map_err(db_error)?;
        return Ok(None);
    };
    let mut ids: Vec<String> = serde_json::from_str(&encoded)
        .map_err(|error| CognitionError::new("memory_graph_unavailable", error.to_string()))?;
    if let Some(id) = completion_id.filter(|value| !value.is_empty())
        && !ids.iter().any(|value| value == id)
    {
        ids.push(id.to_owned());
        ids.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
        tx.execute(
            "UPDATE memory_projection_jobs SET observed_completion_job_ids=?1 WHERE job_id=?2",
            params![serde_json::Value::from(ids).to_string(), job_id],
        )
        .map_err(db_error)?;
    }
    tx.commit().map_err(db_error)?;
    Ok(Some(job_id))
}

pub(super) fn progress(connection: &Connection, job_id: &str) -> CognitionResult<GraphProgress> {
    let row = connection.query_row("SELECT j.job_id,j.observed_completion_job_ids,j.episode_id,j.revision,j.extraction_version,j.generation,j.source_state,j.semantic_graph_state,j.episode_vectors_state,j.node_vectors_state,j.hot_cache_state,c.current_revision FROM memory_projection_jobs j JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id WHERE j.job_id=?1", [job_id], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?,row.get::<_,String>(4)?,row.get::<_,String>(5)?,row.get::<_,String>(6)?,row.get::<_,String>(7)?,row.get::<_,String>(8)?,row.get::<_,String>(9)?,row.get::<_,String>(10)?,row.get::<_,String>(11)?))).optional().map_err(db_error)?;
    let Some((
        job_id,
        ids,
        episode_id,
        revision,
        extraction_version,
        generation,
        source,
        semantic,
        episode_vectors,
        node_vectors,
        hot_cache,
        current,
    )) = row
    else {
        return Err(CognitionError::new(
            "memory_projection_job_not_found",
            "memory_projection_job_not_found",
        ));
    };
    let parse = |value: &str| {
        serde_json::from_str(value)
            .map_err(|error| CognitionError::new("memory_graph_unavailable", error.to_string()))
    };
    let source_value: Value = parse(&source)?;
    let semantic_value: Value = parse(&semantic)?;
    let episode_value: Value = parse(&episode_vectors)?;
    let node_value: Value = parse(&node_vectors)?;
    let hot_value: Value = parse(&hot_cache)?;
    let complete = |value: &Value| value.get("state").and_then(Value::as_str) == Some("complete");
    let outcome = if current != revision {
        "superseded"
    } else if [
        &source_value,
        &semantic_value,
        &episode_value,
        &node_value,
        &hot_value,
    ]
    .into_iter()
    .all(complete)
    {
        "complete"
    } else if !complete(&source_value) {
        "pending"
    } else {
        "partial"
    };
    let observed_completion_job_ids = serde_json::from_str(&ids)
        .map_err(|error| CognitionError::new("memory_graph_unavailable", error.to_string()))?;
    Ok(GraphProgress {
        job_id,
        observed_completion_job_ids,
        episode_id,
        revision,
        extraction_version,
        generation,
        source: source_value,
        semantic_graph: semantic_value,
        episode_vectors: episode_value,
        node_vectors: node_value,
        hot_cache: hot_value,
        outcome: outcome.into(),
    })
}

pub(super) fn refresh_semantic_state(
    connection: &Connection,
    job_id: &str,
    now: &str,
) -> CognitionResult<()> {
    let (total,complete,failed,warnings)=connection.query_row("SELECT COUNT(*),COALESCE(SUM(state='complete'),0),COALESCE(SUM(state='failed'),0),COALESCE(SUM(state='unsupported'),0) FROM memory_projection_windows WHERE job_id=?1 AND state!='replaced'",[job_id],|row|Ok((row.get::<_,i64>(0)?,row.get::<_,i64>(1)?,row.get::<_,i64>(2)?,row.get::<_,i64>(3)?))).map_err(db_error)?;
    let pending = (total - complete - failed - warnings).max(0);
    let state = if complete == total {
        serde_json::json!({"state":"complete","completed_units":complete,"total_units":total})
    } else if complete > 0 || failed > 0 || warnings > 0 {
        let mut value = crate::json::json_object!({"state":"partial","completed_units":complete,"total_units":total,"pending_units":pending,"failed_units":failed});
        if warnings > 0 {
            value.insert("warning_units".into(), warnings.into());
        }
        serde_json::Value::Object(value)
    } else {
        serde_json::json!({"state":"pending","blocked_by":null})
    };
    connection.execute("UPDATE memory_projection_jobs SET semantic_graph_state=?1,last_served_at=?2 WHERE job_id=?3",params![state.to_string(),now,job_id]).map_err(db_error)?;
    if complete + warnings == total {
        let nodes: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM memory_vector_units WHERE job_id=?1 AND record_kind='node'",
                [job_id],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        if nodes == 0 {
            let current: Option<String> = connection
                .query_row(
                    "SELECT node_vectors_state FROM memory_projection_jobs WHERE job_id=?1",
                    [job_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(db_error)?;
            if current
                .as_deref()
                .and_then(|v| serde_json::from_str::<Value>(v).ok())
                .and_then(|v| v.get("state").and_then(Value::as_str).map(str::to_owned))
                .as_deref()
                != Some("not_configured")
            {
                connection
                    .execute(
                        "UPDATE memory_projection_jobs SET node_vectors_state=?1 WHERE job_id=?2",
                        params![
                            r#"{"state":"complete","completed_units":0,"total_units":0}"#,
                            job_id
                        ],
                    )
                    .map_err(db_error)?;
            }
        }
    }
    Ok(())
}
