//! Identity decision history of a projection job: the records stored in
//! `identity_decisions_json`, and the preimage checks an invalidation needs.

use std::collections::HashSet;

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::{db_error, redirect_chain, source};
use crate::cognition::CognitionCode;
use crate::cognition::{CognitionError, CognitionResult, hydrate_conversation_source};
use butler_turn::conversation::ConversationSourceReader;

/// Passthrough: one identity decision record as stored, including fields
/// written by earlier implementations; an invalidation copies it and
/// overwrites only the fields it owns.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(transparent)]
pub(super) struct DecisionRecord(Map<String, Value>);

impl DecisionRecord {
    /// A string field, when present as a string.
    pub(super) fn string(&self, key: &str) -> Option<&str> {
        self.0.get(key).and_then(Value::as_str)
    }

    /// The string items of an array field.
    pub(super) fn strings(&self, key: &str) -> Vec<String> {
        self.0
            .get(key)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect()
    }

    /// A reference `{job_ref, decision_ref}` field.
    fn decision(&self, key: &str) -> Option<DecisionPointer> {
        DecisionPointer::deserialize(self.0.get(key)?).ok()
    }

    /// The source bindings the decision rests on.
    fn source_bindings(&self) -> Vec<SourceBinding> {
        ["decision_source", "loser_source", "canonical_source"]
            .into_iter()
            .filter_map(|key| self.0.get(key))
            .filter(|value| !value.is_null())
            .map(|value| SourceBinding::deserialize(value).unwrap_or_default())
            .collect()
    }

    /// Sets a field, keeping its position when it already exists.
    pub(super) fn set(&mut self, key: &str, value: impl Serialize) {
        self.0.insert(
            key.into(),
            serde_json::to_value(value).unwrap_or(Value::Null),
        );
    }
}

/// A `{job_ref, decision_ref}` pointer to another decision.
#[derive(Debug, Deserialize, Serialize)]
pub(super) struct DecisionPointer {
    #[serde(default, deserialize_with = "crate::lenient::option")]
    pub job_ref: Option<String>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    pub decision_ref: Option<String>,
}

/// A source a decision quoted, as recorded.
#[derive(Debug, Default, Deserialize)]
struct SourceBinding {
    #[serde(default, deserialize_with = "crate::lenient::option")]
    source_ref: Option<String>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    episode_id: Option<String>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    revision: Option<String>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    content_hash: Option<String>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    origin_kind: Option<String>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    role: Option<String>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    observed_at: Option<String>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    byte_start: Option<f64>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    byte_end: Option<f64>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    session_id: Option<String>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    project_id: Option<String>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    quote: Option<String>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    quote_byte_start: Option<f64>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    quote_byte_end: Option<f64>,
}

pub(super) struct Node {
    pub id: String,
    pub canonical: Option<String>,
    pub history_job: Option<String>,
    pub history_ref: Option<String>,
}

pub(super) fn node(connection: &Connection, id: &str) -> CognitionResult<Node> {
    connection
        .query_row(
            "SELECT id,canonical_node_id,identity_history_job_id,identity_history_ref FROM memory_nodes WHERE id=?1",
            [id],
            |row| {
                Ok(Node {
                    id: row.get(0)?,
                    canonical: row.get(1)?,
                    history_job: row.get(2)?,
                    history_ref: row.get(3)?,
                })
            },
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| CognitionError::new(CognitionCode::MemoryIdentityNodeMissing, "memory_identity_node_missing"))
}

/// Whether an applied redirect can be restored: the apply that set it must
/// still rest on current sources and restoring it must not form a cycle.
pub(super) fn valid_preimage(
    connection: &Connection,
    canonical: &ConversationSourceReader,
    record: &DecisionRecord,
) -> CognitionResult<bool> {
    let (Some(previous), Some(head)) = (
        record.string("previous_direct_redirect"),
        record.decision("previous_head"),
    ) else {
        return Ok(false);
    };
    let Some(owner) = find_owning_apply(connection, head, previous)? else {
        return Ok(false);
    };
    if !record_sources_current(connection, canonical, &owner)? {
        return Ok(false);
    }
    Ok(!redirect_chain(connection, previous)
        .unwrap_or_default()
        .iter()
        .any(|id| Some(id.as_str()) == record.string("literal_loser")))
}

/// Follows `previous_head` pointers (through revokes and invalidations of
/// the same redirect) to the apply that set `direct`.
fn find_owning_apply(
    connection: &Connection,
    initial: DecisionPointer,
    direct: &str,
) -> CognitionResult<Option<DecisionRecord>> {
    let mut head = Some(initial);
    let mut visited = HashSet::new();
    while let Some(pointer) = head.take() {
        if visited.len() >= 64 {
            return Ok(None);
        }
        let (Some(job), Some(reference)) = (pointer.job_ref, pointer.decision_ref) else {
            return Ok(None);
        };
        if !visited.insert(format!("{job}\0{reference}")) {
            return Ok(None);
        }
        let Some(record) = find_record(connection, &job, &reference)? else {
            return Ok(None);
        };
        if record.string("operation") == Some("apply")
            && record.string("resulting_direct_redirect") == Some(direct)
        {
            return Ok(Some(record));
        }
        head = next_head(connection, &record, direct)?;
    }
    Ok(None)
}

fn find_record(
    connection: &Connection,
    job: &str,
    reference: &str,
) -> CognitionResult<Option<DecisionRecord>> {
    Ok(records_for_job(connection, job)?
        .into_iter()
        .find(|row| row.string("decision_ref") == Some(reference)))
}

fn next_head(
    connection: &Connection,
    record: &DecisionRecord,
    direct: &str,
) -> CognitionResult<Option<DecisionPointer>> {
    if !(matches!(record.string("operation"), Some("revoke" | "invalidate"))
        && record.string("resulting_direct_redirect") == Some(direct))
    {
        return Ok(record.decision("previous_head"));
    }
    let Some(target) = record.decision("target_decision") else {
        return Ok(None);
    };
    let (Some(job), Some(reference)) = (target.job_ref, target.decision_ref) else {
        return Ok(None);
    };
    Ok(find_record(connection, &job, &reference)?
        .and_then(|target| target.decision("previous_head")))
}

fn record_sources_current(
    connection: &Connection,
    canonical: &ConversationSourceReader,
    record: &DecisionRecord,
) -> CognitionResult<bool> {
    let bindings = record.source_bindings();
    if bindings.is_empty() {
        return Ok(false);
    }
    for binding in &bindings {
        if !binding_current(connection, canonical, binding)? {
            return Ok(false);
        }
    }
    Ok(true)
}

/// A recorded source binding must still match its current row, chunk, and
/// canonical text.
fn binding_current(
    connection: &Connection,
    canonical: &ConversationSourceReader,
    binding: &SourceBinding,
) -> CognitionResult<bool> {
    let Some(reference) = binding.source_ref.as_deref() else {
        return Ok(false);
    };
    let Some(row) = source(connection, reference)? else {
        return Ok(false);
    };
    for (recorded, actual) in [
        (&binding.episode_id, row.episode_id.as_str()),
        (&binding.revision, row.revision.as_str()),
        (&binding.content_hash, row.content_hash.as_str()),
        (&binding.origin_kind, row.origin_kind.as_str()),
        (&binding.role, row.role.as_str()),
        (&binding.observed_at, row.observed_at.as_str()),
    ] {
        if recorded.as_deref() != Some(actual) {
            return Ok(false);
        }
    }
    if binding.byte_start != Some(row.byte_start)
        || binding.byte_end != Some(row.byte_end)
        || binding.session_id.as_deref() != row.conversation_session_id.as_deref()
    {
        return Ok(false);
    }
    let chunk = connection
        .query_row(
            "SELECT current_revision,project_id FROM memory_chunks WHERE memory_chunk_id=?1",
            [&row.episode_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()
        .map_err(db_error)?;
    if !chunk.is_some_and(|(revision, project)| {
        revision == row.revision && project.as_deref() == binding.project_id.as_deref()
    }) {
        return Ok(false);
    }
    let Some(message_id) = &row.conversation_message_id else {
        return Ok(false);
    };
    let Ok(Some(message)) = canonical.read_message(message_id) else {
        return Ok(false);
    };
    let Ok(hydrated) = hydrate_conversation_source(&message, &row, f64::INFINITY) else {
        return Ok(false);
    };
    let quote = binding.quote.as_deref().unwrap_or("");
    if quote.is_empty() {
        return Ok(true);
    }
    let start = binding.quote_byte_start.unwrap_or(-1.0) - row.byte_start;
    let end = binding.quote_byte_end.unwrap_or(-1.0) - row.byte_start;
    if start < 0.0 || end < start {
        return Ok(false);
    }
    Ok(hydrated
        .text
        .as_bytes()
        .get(butler_core::json::saturating_usize(start)..butler_core::json::saturating_usize(end))
        .and_then(|bytes| std::str::from_utf8(bytes).ok())
        == Some(quote))
}

/// The job's stored decision records; a job without history has none.
pub(super) fn records_for_job(
    connection: &Connection,
    job: &str,
) -> CognitionResult<Vec<DecisionRecord>> {
    let value = connection
        .query_row(
            "SELECT identity_decisions_json FROM memory_projection_jobs WHERE job_id=?1",
            [job],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(db_error)?;
    match value {
        None => Ok(Vec::new()),
        Some(value) => serde_json::from_str(&value).map_err(|error| {
            CognitionError::new(
                CognitionCode::MemoryIdentityHistoryInvalid,
                error.to_string(),
            )
            .with_source(error)
        }),
    }
}

/// Appends `record` unless the job already has its decision.
pub(super) fn append_record(
    connection: &Connection,
    job: &str,
    record: &DecisionRecord,
) -> CognitionResult<()> {
    let mut records = records_for_job(connection, job)?;
    if !records
        .iter()
        .any(|value| value.string("decision_ref") == record.string("decision_ref"))
    {
        records.push(record.clone());
        connection
            .execute(
                "UPDATE memory_projection_jobs SET identity_decisions_json=?1 WHERE job_id=?2",
                params![serde_json::to_string(&records).unwrap_or_default(), job],
            )
            .map_err(db_error)?;
    }
    Ok(())
}
