//! Historical decision records and source-currentness checks.

use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;

use crate::cognition::{
    CognitionResult,
    recall::{IdentityReadScope, IdentitySourceBinding, RecallProjectFilter, RecallScope},
};

use super::super::db_error;

#[derive(Clone, Debug, Deserialize)]
pub(super) struct HistoryRef {
    pub job_ref: String,
    pub decision_ref: String,
}

#[derive(Clone, Debug, Deserialize)]
pub(super) struct Decision {
    pub decision_ref: String,
    pub operation: String,
    pub literal_loser: String,
    pub literal_canonical: Option<String>,
    pub resolved_target: Option<String>,
    pub resulting_direct_redirect: Option<String>,
    pub previous_head: Option<HistoryRef>,
    pub target_decision: Option<HistoryRef>,
    pub decision_source: IdentitySourceBinding,
    pub loser_source: Option<IdentitySourceBinding>,
    pub canonical_source: Option<IdentitySourceBinding>,
    pub source_observed_at: String,
    pub recorded_at: String,
}

pub(super) fn for_job(db: &Connection, job: &str) -> CognitionResult<Vec<Decision>> {
    let value = db
        .query_row(
            "SELECT identity_decisions_json FROM memory_projection_jobs WHERE job_id=?1",
            [job],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(db_error)?;
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    serde_json::from_str(&value).map_err(|error| {
        crate::cognition::CognitionError::new("memory_graph_unavailable", error.to_string())
    })
}

pub(super) fn find(db: &Connection, head: &HistoryRef) -> CognitionResult<Option<Decision>> {
    Ok(for_job(db, &head.job_ref)?
        .into_iter()
        .find(|record| record.decision_ref == head.decision_ref))
}

pub(super) fn scope_status(
    db: &Connection,
    record: &Decision,
    scope: &IdentityReadScope,
    parse_date: &dyn Fn(&str) -> f64,
    source_current: &mut impl FnMut(&IdentitySourceBinding) -> bool,
) -> CognitionResult<(bool, bool)> {
    let bindings = std::iter::once(&record.decision_source)
        .chain(record.loser_source.iter())
        .chain(record.canonical_source.iter())
        .collect::<Vec<_>>();
    if bindings.is_empty()
        || bindings
            .iter()
            .any(|binding| !in_scope(binding, scope, parse_date))
    {
        return Ok((false, false));
    }
    for binding in bindings {
        if !graph_current(db, binding)? || !source_current(binding) {
            return Ok((true, false));
        }
    }
    Ok((true, true))
}

fn in_scope(
    binding: &IdentitySourceBinding,
    input: &IdentityReadScope,
    parse_date: &dyn Fn(&str) -> f64,
) -> bool {
    if !input.include_internal
        && binding.origin_kind != "user_input"
        && binding.origin_kind != "assistant_public"
    {
        return false;
    }
    if parse_date(&binding.observed_at) > parse_date(&input.as_of) {
        return false;
    }
    if input.scope == RecallScope::CurrentSession && binding.session_id != input.current_session_id
    {
        return false;
    }
    if input.scope == RecallScope::CurrentProject && binding.project_id != input.current_project_id
    {
        return false;
    }
    if !input.session_ids.is_empty() && !input.session_ids.contains(&binding.session_id) {
        return false;
    }
    if input.project_filter == RecallProjectFilter::Unassigned && binding.project_id.is_some() {
        return false;
    }
    if input.project_filter == RecallProjectFilter::Selected
        && binding
            .project_id
            .as_ref()
            .is_none_or(|id| !input.project_ids.contains(id))
    {
        return false;
    }
    true
}

fn graph_current(db: &Connection, binding: &IdentitySourceBinding) -> CognitionResult<bool> {
    let source = db.query_row(
        "SELECT episode_id,revision,content_hash,byte_start,byte_end,conversation_session_id,origin_kind,role,observed_at
         FROM memory_chunk_sources WHERE source_id=?1
         UNION ALL
         SELECT episode_id,revision,content_hash,byte_start,byte_end,conversation_session_id,origin_kind,role,observed_at
         FROM memory_source_split_parents WHERE source_id=?1 LIMIT 1",
        [&binding.source_ref],
        |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,
            row.get::<_,i64>(3)?,row.get::<_,i64>(4)?,row.get::<_,String>(5)?,
            row.get::<_,String>(6)?,row.get::<_,String>(7)?,row.get::<_,String>(8)?)),
    ).optional().map_err(db_error)?;
    let Some((episode, revision, hash, start, end, session, origin, role, observed)) = source
    else {
        return Ok(false);
    };
    if episode != binding.episode_id
        || revision != binding.revision
        || hash != binding.content_hash
        || start != binding.byte_start
        || end != binding.byte_end
        || session != binding.session_id
        || origin != binding.origin_kind
        || role != binding.role
        || observed != binding.observed_at
    {
        return Ok(false);
    }
    let chunk = db
        .query_row(
            "SELECT current_revision,project_id FROM memory_chunks WHERE memory_chunk_id=?1",
            params![binding.episode_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()
        .map_err(db_error)?;
    Ok(chunk.is_some_and(|(current, project)| {
        current == binding.revision && project == binding.project_id
    }))
}
