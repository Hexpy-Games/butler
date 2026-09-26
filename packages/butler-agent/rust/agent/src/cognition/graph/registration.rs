use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

use super::{db_error, index, invalidation, jobs};
use crate::cognition::{
    CognitionError, CognitionResult, CognitionSourcePlan, CognitionSourceRow,
    ConversationSourceNotice, MEMORY_SOURCE_WINDOW_BYTES, assert_conversation_source_current,
    hydrate_conversation_source,
};
use crate::conversation::{ConversationMessageWithParts, ConversationSourceReader};

#[derive(Clone, Copy)]
pub(in crate::cognition) struct RegistrationInput<'a> {
    pub generation_id: &'a str,
    pub plan: &'a CognitionSourcePlan,
    pub notice: ConversationSourceNotice<'a>,
    pub canonical: &'a ConversationSourceReader,
    pub completion_id: Option<&'a str>,
    pub extraction_model: &'a str,
    pub reasoning_effort: &'a str,
    pub clock: &'a dyn Fn() -> String,
}

pub(in crate::cognition) struct GraphRegistration {
    pub job_id: String,
}

pub(super) fn register(
    connection: &mut Connection,
    input: RegistrationInput<'_>,
) -> CognitionResult<GraphRegistration> {
    let tx = connection.transaction().map_err(db_error)?;
    assert_conversation_source_current(
        input.canonical,
        input.notice,
        &input.plan.revision,
        &(input.clock)(),
    )?;
    let now = (input.clock)();
    let prior_revision = tx
        .query_row(
            "SELECT current_revision FROM memory_chunks WHERE source_key=?1",
            [&input.plan.source_key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(db_error)?;
    let prior_sources = prior_source_ids(&tx, &input.plan.episode_id, prior_revision.as_deref())?;
    let project_id = input
        .canonical
        .read_session(&input.plan.session_id)
        .map_err(conversation_error)?
        .and_then(|session| session.project_id);
    upsert_chunk(&tx, &input, project_id.as_deref(), &now)?;

    let (completion_ids, existing_job) = completion_ids(&tx, &input)?;
    tx.execute(
        "INSERT OR IGNORE INTO memory_nodes(id,type,label_original,identity_scope,project_id,created_at) \
         VALUES(?1,'episode',?1,'user',NULL,?2)",
        params![input.plan.episode_id, now],
    )
    .map_err(db_error)?;

    let mut messages = HashMap::<String, ConversationMessageWithParts>::new();
    let mut registered = Vec::new();
    for row in &input.plan.rows {
        let replacements = replacement_source_refs(&tx, &row.source_id)?;
        if !replacements.is_empty() {
            registered.extend(replacements);
            continue;
        }
        insert_source(&tx, row)?;
        let message_id = row
            .conversation_message_id
            .as_deref()
            .ok_or_else(source_changed)?;
        let message = match messages.entry(message_id.to_owned()) {
            std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
            std::collections::hash_map::Entry::Vacant(entry) => entry.insert(
                input
                    .canonical
                    .read_message(message_id)
                    .map_err(conversation_error)?
                    .ok_or_else(source_changed)?,
            ),
        };
        let hydrated = hydrate_conversation_source(message, row, f64::INFINITY)?;
        index::index_source(&tx, &row.source_id, hydrated.text)?;
        registered.push(row.source_id.clone());
    }
    insert_job(&tx, &input, &completion_ids, registered.len(), &now)?;
    if !existing_job {
        insert_windows(&tx, input.plan, &registered)?;
    }
    if prior_revision
        .as_deref()
        .is_some_and(|value| value != input.plan.revision)
    {
        invalidation::superseded_sources(
            &tx,
            invalidation::InvalidationInput {
                old_source_ids: &prior_sources,
                new_job_id: &input.plan.job_id,
                new_episode_id: &input.plan.episode_id,
                new_revision: &input.plan.revision,
                recorded_at: &now,
                canonical: input.canonical,
            },
        )?;
    }
    jobs::refresh_semantic_state(&tx, &input.plan.job_id, &(input.clock)())?;
    tx.commit().map_err(db_error)?;
    Ok(GraphRegistration {
        job_id: input.plan.job_id.clone(),
    })
}

fn prior_source_ids(
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

fn upsert_chunk(
    connection: &Connection,
    input: &RegistrationInput<'_>,
    project_id: Option<&str>,
    now: &str,
) -> CognitionResult<()> {
    connection.execute(
        "INSERT INTO memory_chunks(memory_chunk_id,source_key,current_revision,conversation_session_id,conversation_turn_id,conversation_start,conversation_end,project_id,origin_kind,status,source_hash,created_at,updated_at) \
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,'active',?10,?11,?11) \
         ON CONFLICT(source_key) DO UPDATE SET current_revision=excluded.current_revision,updated_at=excluded.updated_at, \
         summary=CASE WHEN memory_chunks.current_revision!=excluded.current_revision THEN '' ELSE memory_chunks.summary END, \
         summary_status=CASE WHEN memory_chunks.current_revision!=excluded.current_revision THEN 'pending' ELSE memory_chunks.summary_status END",
        params![input.plan.episode_id,input.plan.source_key,input.plan.revision,input.plan.session_id,input.plan.turn_id,input.plan.conversation_start,input.plan.conversation_end,project_id,input.plan.origin_kind,input.plan.source_hash,now],
    ).map_err(db_error)?;
    Ok(())
}

fn completion_ids(
    connection: &Connection,
    input: &RegistrationInput<'_>,
) -> CognitionResult<(Vec<String>, bool)> {
    let existing = connection
        .query_row(
            "SELECT observed_completion_job_ids FROM memory_projection_jobs WHERE job_id=?1",
            [&input.plan.job_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(db_error)?;
    let exists = existing.is_some();
    let mut ids = match existing {
        Some(value) => serde_json::from_str::<Vec<String>>(&value).map_err(json_error)?,
        None => Vec::new(),
    };
    if let Some(id) = input.completion_id.filter(|value| !value.is_empty())
        && !ids.iter().any(|value| value == id)
    {
        ids.push(id.to_owned());
    }
    ids.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    Ok((ids, exists))
}

fn insert_source(connection: &Connection, row: &CognitionSourceRow) -> CognitionResult<()> {
    connection.execute(
        "INSERT OR IGNORE INTO memory_chunk_sources(source_id,episode_id,revision,source_kind,conversation_session_id,conversation_message_id,part_id,scalar_pointer,byte_start,byte_end,content_hash,role,origin_kind,observed_at,basis) \
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
        params![row.source_id,row.episode_id,row.revision,row.source_kind,row.conversation_session_id,row.conversation_message_id,row.part_id,row.scalar_pointer,row.byte_start,row.byte_end,row.content_hash,row.role,row.origin_kind,row.observed_at,row.basis],
    ).map_err(db_error)?;
    Ok(())
}

fn insert_job(
    connection: &Connection,
    input: &RegistrationInput<'_>,
    completion_ids: &[String],
    source_count: usize,
    now: &str,
) -> CognitionResult<()> {
    let complete =
        json!({"state":"complete","completed_units":source_count,"total_units":source_count});
    let pending = json!({"state":"pending","blocked_by":null});
    connection.execute(
        "INSERT INTO memory_projection_jobs(job_id,episode_id,revision,extraction_version,generation,extraction_model,reasoning_effort,observed_completion_job_ids,source_state,semantic_graph_state,episode_vectors_state,node_vectors_state,hot_cache_state,created_at) \
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?10,?10,?10,?11) \
         ON CONFLICT(episode_id,revision,extraction_version) DO UPDATE SET observed_completion_job_ids=excluded.observed_completion_job_ids",
        params![input.plan.job_id,input.plan.episode_id,input.plan.revision,input.plan.extraction_version,input.generation_id,input.extraction_model,input.reasoning_effort,crate::json::stringify(&serde_json::to_value(completion_ids).map_err(json_error)?).map_err(json_error)?,crate::json::stringify(&complete).map_err(json_error)?,crate::json::stringify(&pending).map_err(json_error)?,now],
    ).map_err(db_error)?;
    Ok(())
}

fn insert_windows(
    connection: &Connection,
    plan: &CognitionSourcePlan,
    registered: &[String],
) -> CognitionResult<()> {
    let windows = registered
        .iter()
        .map(|source_id| {
            let (start, end) = source_span(connection, source_id)?;
            if end - start > MEMORY_SOURCE_WINDOW_BYTES {
                return Err(CognitionError::new(
                    "memory_extract_source_window_exceeds_budget",
                    "memory_extract_source_window_exceeds_budget",
                ));
            }
            Ok(source_id)
        })
        .collect::<CognitionResult<Vec<_>>>()?;
    for (ordinal, source_id) in windows.into_iter().enumerate() {
        let refs = vec![source_id.clone()];
        let window = crate::cognition::sources::projection_hash_for_graph(vec![
            Value::String("memory-window".into()),
            Value::String(plan.revision.clone()),
            Value::String(source_id.clone()),
        ])?;
        connection.execute(
            "INSERT INTO memory_projection_windows(window_ref,job_id,ordinal,source_refs_json,state,error_code) VALUES(?1,?2,?3,?4,?5,?6)",
            params![window,plan.job_id,i64::try_from(ordinal).unwrap_or(i64::MAX),serde_json::to_string(&refs).map_err(json_error)?,"pending",Option::<&str>::None],
        ).map_err(db_error)?;
    }
    Ok(())
}

fn source_span(connection: &Connection, source_id: &str) -> CognitionResult<(f64, f64)> {
    connection
        .query_row(
            "SELECT byte_start,byte_end FROM memory_chunk_sources WHERE source_id=?1",
            [source_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(source_changed)
}

fn replacement_source_refs(
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

fn source_changed() -> CognitionError {
    CognitionError::new("memory_source_changed", "memory_source_changed")
}

fn conversation_error(error: crate::conversation::ConversationError) -> CognitionError {
    CognitionError::new(error.code, error.message)
}

fn json_error(error: impl std::fmt::Display) -> CognitionError {
    CognitionError::new("memory_graph_unavailable", error.to_string())
}
