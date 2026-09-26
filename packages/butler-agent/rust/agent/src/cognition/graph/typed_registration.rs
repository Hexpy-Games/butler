//! Registration of typed source records into the existing cognition graph.

mod plan;
mod rows;

use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params};

use super::{GraphRegistration, db_error, index, invalidation, jobs};
use crate::cognition::{CognitionError, CognitionResult, sources, sources::TypedPlan};
use crate::conversation::ConversationSourceReader;

#[derive(Clone, Copy)]
pub(in crate::cognition) struct TypedRegistrationInput<'a> {
    pub generation_id: &'a str,
    pub data_root: &'a Path,
    pub memory_root: &'a Path,
    pub plan: &'a TypedPlan,
    pub owner: &'a sources::TypedMemoryRecord,
    pub canonical: &'a ConversationSourceReader,
    pub cursor_key: Option<&'a str>,
    pub cursor_snapshot_id: Option<&'a str>,
    pub completion_id: Option<&'a str>,
    pub extraction_model: &'a str,
    pub reasoning_effort: &'a str,
    pub clock: &'a dyn Fn() -> String,
}

pub(super) fn register_typed(
    connection: &mut Connection,
    input: TypedRegistrationInput<'_>,
) -> CognitionResult<GraphRegistration> {
    plan::validate(&input)?;
    let tx = connection.transaction().map_err(db_error)?;
    plan::assert_owner_current(&input)?;
    plan::persist_rebuild_cursor(&tx, &input)?;
    let now = (input.clock)();
    if let Some(job_id) = rows::existing_job(&tx, input.plan, input.completion_id)? {
        tx.commit().map_err(db_error)?;
        return Ok(GraphRegistration { job_id });
    }

    let prior_revision = tx
        .query_row(
            "SELECT current_revision FROM memory_chunks WHERE source_key=?1",
            [&input.plan.source_key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(db_error)?;
    let prior_sources =
        rows::prior_source_ids(&tx, &input.plan.episode_id, prior_revision.as_deref())?;

    rows::upsert_chunk(&tx, &input, &now)?;
    tx.execute(
        "INSERT OR IGNORE INTO memory_nodes(id,type,label_original,identity_scope,project_id,created_at) \
         VALUES(?1,'episode',?1,'user',NULL,?2)",
        params![input.plan.episode_id, now],
    )
    .map_err(db_error)?;

    let mut registered = Vec::new();
    for span in &input.plan.spans {
        let replacements = rows::replacement_source_refs(&tx, &span.row.source_id)?;
        if !replacements.is_empty() {
            registered.extend(replacements);
            continue;
        }
        rows::insert_source(&tx, &span.row)?;
        index::index_source(&tx, &span.row.source_id, &span.text)?;
        registered.push(span.row.source_id.clone());
    }
    let job_already_exists = tx
        .query_row(
            "SELECT 1 FROM memory_projection_jobs WHERE job_id=?1",
            [&input.plan.job_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(db_error)?
        .is_some();
    rows::insert_job(&tx, &input, registered.len(), &now)?;
    if !job_already_exists {
        rows::insert_windows(&tx, input.plan, &registered)?;
    }
    if prior_revision
        .as_deref()
        .is_some_and(|revision| revision != input.plan.revision)
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

fn source_changed() -> CognitionError {
    CognitionError::new("memory_source_changed", "memory_source_changed")
}
