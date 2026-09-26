//! Build a pinned extraction input from registered graph rows and the canonical reader.

mod adjacent;

use std::collections::HashMap;
use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params};

use super::db_error;
use crate::cognition::{
    CognitionError, CognitionResult, CognitionSourceRow, extraction::ExtractInput,
    extraction::ProjectionContextUnit, extraction::ProjectionSourceUnit,
    hydrate_conversation_source, read_prior_public_context, sources::hydrate_typed_source,
};
use crate::conversation::{ConversationMessageWithParts, ConversationSourceReader};

pub(super) fn build(
    connection: &Connection,
    canonical: &ConversationSourceReader,
    source_root: &Path,
    job_id: &str,
    window_ref: &str,
    source_refs: &[String],
) -> CognitionResult<ExtractInput> {
    let chunk = connection
        .query_row(
            "SELECT c.memory_chunk_id,c.current_revision,c.project_id FROM memory_chunks c \
         JOIN memory_projection_jobs j ON j.episode_id=c.memory_chunk_id WHERE j.job_id=?1",
            [job_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(source_changed)?;

    let mut messages = HashMap::<String, ConversationMessageWithParts>::new();
    let mut rows = Vec::with_capacity(source_refs.len());
    let mut units = Vec::with_capacity(source_refs.len());
    for source_ref in source_refs {
        let row = source_row(connection, source_ref)?.ok_or_else(source_changed)?;
        if row.revision != chunk.1 {
            return Err(source_changed());
        }
        let text = hydrate_row(canonical, source_root, &row, &mut messages)?;
        let eligible = match row.role.as_str() {
            "user" => row.origin_kind == "user_input",
            "assistant" => row.origin_kind == "assistant_public",
            "task" => row.source_kind == "task_report",
            "explicit" => row.source_kind == "explicit_record",
            _ => false,
        };
        if !eligible {
            return Err(CognitionError::new(
                "memory_source_ineligible",
                "memory_source_ineligible",
            ));
        }
        units.push(ProjectionSourceUnit {
            ref_id: row.source_id.clone(),
            text,
            role: row.role.clone(),
            observed_at: row.observed_at.clone(),
            origin_kind: row.origin_kind.clone(),
        });
        rows.push(row);
    }
    let mut context_units = if let Some(session) = rows
        .first()
        .and_then(|row| row.conversation_session_id.as_deref())
    {
        read_prior_public_context(canonical, session, &rows)?
            .into_iter()
            .map(|unit| ProjectionContextUnit {
                ref_id: unit.ref_id,
                text: unit.text,
                observed_at: unit.observed_at,
                basis: unit.basis,
                source_span: None,
            })
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    if let Some(previous_json) = connection.query_row(
        "SELECT source_refs_json FROM memory_projection_windows WHERE job_id=?1 AND state!='replaced' \
         AND ordinal<(SELECT ordinal FROM memory_projection_windows WHERE window_ref=?2) \
         ORDER BY ordinal DESC LIMIT 1", params![job_id,window_ref], |row| row.get::<_,String>(0),
    ).optional().map_err(db_error)? {
        let previous: Vec<String> = serde_json::from_str(&previous_json).map_err(json_error)?;
        if let Some(last) = previous.last() {
            let row = source_row(connection, last)?.ok_or_else(source_changed)?;
            let text = hydrate_row(canonical, source_root, &row, &mut messages)?;
            context_units.push(ProjectionContextUnit { ref_id: row.source_id.clone(), text,
                observed_at: row.observed_at, basis: row.basis, source_span: None });
        }
    }
    let mut input = ExtractInput {
        schema: "butler.memory-extract-input.v2".into(),
        episode_ref: chunk.0,
        revision: chunk.1,
        window_ref: window_ref.into(),
        bound_project_id: chunk.2,
        source_units: units,
        context_expansion: None,
        context_units,
        candidates: Vec::new(),
    };
    adjacent::attach(&mut input, &rows, &messages, source_root, 0)?;
    enforce_budget(&mut input)?;
    Ok(input)
}

pub(super) fn expand(
    connection: &Connection,
    canonical: &ConversationSourceReader,
    source_root: &Path,
    input: &ExtractInput,
) -> CognitionResult<ExtractInput> {
    let mut messages = HashMap::<String, ConversationMessageWithParts>::new();
    let mut rows = Vec::new();
    for unit in &input.source_units {
        let row = source_row(connection, &unit.ref_id)?.ok_or_else(source_changed)?;
        hydrate_row(canonical, source_root, &row, &mut messages)?;
        rows.push(row);
    }
    let mut revised = input.clone();
    revised.candidates.clear();
    adjacent::attach(&mut revised, &rows, &messages, source_root, 1)?;
    enforce_budget(&mut revised)?;
    Ok(revised)
}

fn hydrate_row(
    canonical: &ConversationSourceReader,
    source_root: &Path,
    row: &CognitionSourceRow,
    messages: &mut HashMap<String, ConversationMessageWithParts>,
) -> CognitionResult<String> {
    if matches!(row.source_kind.as_str(), "task_report" | "explicit_record") {
        return hydrate_typed_source(source_root, row);
    }
    let message_id = row
        .conversation_message_id
        .as_deref()
        .ok_or_else(source_changed)?;
    if !messages.contains_key(message_id) {
        messages.insert(
            message_id.to_owned(),
            canonical
                .read_message(message_id)
                .map_err(conversation_error)?
                .ok_or_else(source_changed)?,
        );
    }
    Ok(hydrate_conversation_source(
        messages.get(message_id).expect("inserted"),
        row,
        f64::INFINITY,
    )?
    .text
    .to_owned())
}

pub(super) fn source_row(
    connection: &Connection,
    source_ref: &str,
) -> CognitionResult<Option<CognitionSourceRow>> {
    connection.query_row(
        "SELECT source_id,episode_id,revision,source_kind,conversation_session_id,conversation_message_id,\
         part_id,scalar_pointer,byte_start,byte_end,content_hash,role,origin_kind,observed_at,basis \
         FROM memory_source_leaves WHERE source_id=?1", [source_ref], |row| {
            Ok(CognitionSourceRow {
                source_id:row.get(0)?,episode_id:row.get(1)?,revision:row.get(2)?,source_kind:row.get(3)?,
                conversation_session_id:row.get(4)?,conversation_message_id:row.get(5)?,part_id:row.get(6)?,
                scalar_pointer:row.get(7)?,byte_start:row.get(8)?,byte_end:row.get(9)?,
                content_hash:row.get(10)?,role:row.get(11)?,origin_kind:row.get(12)?,
                observed_at:row.get(13)?,basis:row.get(14)?,
            })
        },
    ).optional().map_err(db_error)
}

fn enforce_budget(input: &mut ExtractInput) -> CognitionResult<()> {
    while json_bytes(&input.context_units)? > 4096 && input.context_units.len() > 1 {
        input.context_units.remove(0);
    }
    if json_bytes(&input.context_units)? > 4096 {
        input.context_units.clear();
    }
    while json_bytes(input)? > 24_576 && !input.context_units.is_empty() {
        input.context_units.remove(0);
    }
    if json_bytes(input)? > 24_576 {
        return Err(CognitionError::new(
            "memory_extract_input_exceeds_budget",
            "memory_extract_input_exceeds_budget",
        ));
    }
    Ok(())
}
fn json_bytes<T: serde::Serialize>(value: &T) -> CognitionResult<usize> {
    Ok(
        crate::json::stringify(&serde_json::to_value(value).map_err(json_error)?)
            .map_err(json_error)?
            .len(),
    )
}
fn source_changed() -> CognitionError {
    CognitionError::new("memory_source_changed", "memory_source_changed")
}
fn json_error(error: impl std::fmt::Display) -> CognitionError {
    CognitionError::new("memory_extract_invalid_json", error.to_string())
}
fn conversation_error(error: crate::conversation::ConversationError) -> CognitionError {
    CognitionError::new(error.code, error.message)
}
