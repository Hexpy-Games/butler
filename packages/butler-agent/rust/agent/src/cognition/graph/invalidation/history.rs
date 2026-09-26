use std::collections::HashSet;

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use super::{db_error, redirect_chain, source};
use crate::cognition::{CognitionError, CognitionResult, hydrate_conversation_source};
use crate::conversation::ConversationSourceReader;

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
        .ok_or_else(|| CognitionError::new("memory_identity_node_missing", "memory_identity_node_missing"))
}

pub(super) fn valid_preimage(
    connection: &Connection,
    canonical: &ConversationSourceReader,
    record: &Value,
) -> CognitionResult<bool> {
    let (Some(previous), Some(head)) = (
        string(record, "previous_direct_redirect"),
        record.get("previous_head"),
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
        .any(|id| Some(id.as_str()) == string(record, "literal_loser")))
}

fn find_owning_apply(
    connection: &Connection,
    initial: &Value,
    direct: &str,
) -> CognitionResult<Option<Value>> {
    let mut head = Some(initial.clone());
    let mut visited = HashSet::new();
    while let Some(value) = head.take() {
        if visited.len() >= 64 {
            return Ok(None);
        }
        let (Some(job), Some(reference)) =
            (string(&value, "job_ref"), string(&value, "decision_ref"))
        else {
            return Ok(None);
        };
        if !visited.insert(format!("{job}\0{reference}")) {
            return Ok(None);
        }
        let Some(record) = records_for_job(connection, job)?
            .into_iter()
            .find(|row| string(row, "decision_ref") == Some(reference))
        else {
            return Ok(None);
        };
        if string(&record, "operation") == Some("apply")
            && string(&record, "resulting_direct_redirect") == Some(direct)
        {
            return Ok(Some(record));
        }
        head = next_head(connection, &record, direct)?;
    }
    Ok(None)
}

fn next_head(
    connection: &Connection,
    record: &Value,
    direct: &str,
) -> CognitionResult<Option<Value>> {
    if matches!(string(record, "operation"), Some("revoke" | "invalidate"))
        && string(record, "resulting_direct_redirect") == Some(direct)
    {
        let Some(target) = record.get("target_decision") else {
            return Ok(None);
        };
        let (Some(job), Some(reference)) =
            (string(target, "job_ref"), string(target, "decision_ref"))
        else {
            return Ok(None);
        };
        let target = records_for_job(connection, job)?
            .into_iter()
            .find(|row| string(row, "decision_ref") == Some(reference));
        Ok(target.and_then(|target| target.get("previous_head").cloned()))
    } else {
        Ok(record.get("previous_head").cloned())
    }
}

fn record_sources_current(
    connection: &Connection,
    canonical: &ConversationSourceReader,
    record: &Value,
) -> CognitionResult<bool> {
    let bindings = ["decision_source", "loser_source", "canonical_source"]
        .into_iter()
        .filter_map(|key| record.get(key))
        .filter(|value| !value.is_null())
        .collect::<Vec<_>>();
    if bindings.is_empty() {
        return Ok(false);
    }
    for binding in bindings {
        if !binding_current(connection, canonical, binding)? {
            return Ok(false);
        }
    }
    Ok(true)
}

fn binding_current(
    connection: &Connection,
    canonical: &ConversationSourceReader,
    binding: &Value,
) -> CognitionResult<bool> {
    let Some(reference) = string(binding, "source_ref") else {
        return Ok(false);
    };
    let Some(row) = source(connection, reference)? else {
        return Ok(false);
    };
    for (field, actual) in [
        ("episode_id", row.episode_id.as_str()),
        ("revision", row.revision.as_str()),
        ("content_hash", row.content_hash.as_str()),
        ("origin_kind", row.origin_kind.as_str()),
        ("role", row.role.as_str()),
        ("observed_at", row.observed_at.as_str()),
    ] {
        if string(binding, field) != Some(actual) {
            return Ok(false);
        }
    }
    if number(binding, "byte_start") != Some(row.byte_start)
        || number(binding, "byte_end") != Some(row.byte_end)
        || string(binding, "session_id") != row.conversation_session_id.as_deref()
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
        revision == row.revision && project.as_deref() == string(binding, "project_id")
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
    let quote = string(binding, "quote").unwrap_or("");
    if quote.is_empty() {
        return Ok(true);
    }
    let start = number(binding, "quote_byte_start").unwrap_or(-1.0) - row.byte_start;
    let end = number(binding, "quote_byte_end").unwrap_or(-1.0) - row.byte_start;
    if start < 0.0 || end < start {
        return Ok(false);
    }
    Ok(hydrated
        .text
        .as_bytes()
        .get(crate::json::saturating_usize(start)..crate::json::saturating_usize(end))
        .and_then(|bytes| std::str::from_utf8(bytes).ok())
        == Some(quote))
}

pub(super) fn records_for_job(connection: &Connection, job: &str) -> CognitionResult<Vec<Value>> {
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
            CognitionError::new("memory_identity_history_invalid", error.to_string())
        }),
    }
}

pub(super) fn append_record(
    connection: &Connection,
    job: &str,
    record: &Value,
) -> CognitionResult<()> {
    let mut records = records_for_job(connection, job)?;
    if !records
        .iter()
        .any(|value| string(value, "decision_ref") == string(record, "decision_ref"))
    {
        records.push(record.clone());
        connection
            .execute(
                "UPDATE memory_projection_jobs SET identity_decisions_json=?1 WHERE job_id=?2",
                params![Value::Array(records).to_string(), job],
            )
            .map_err(db_error)?;
    }
    Ok(())
}

fn string<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}
fn number(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(Value::as_f64)
}
