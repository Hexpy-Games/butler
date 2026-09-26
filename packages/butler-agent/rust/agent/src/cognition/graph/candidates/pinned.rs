//! Rehydrate only explicitly pinned candidate IDs for operator input repair.

use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::Arc,
};

use rusqlite::{Connection, OptionalExtension};

use super::{CandidateAppendContext, CandidateSlices, append, db_error};
use crate::{
    cognition::{
        CognitionError, CognitionResult, ConversationSourceNotice,
        assert_conversation_source_current,
        extraction::{ExtractCandidate, ExtractInput},
        graph::input,
        hydrate_conversation_source,
        sources::hydrate_typed_source,
    },
    conversation::ConversationSourceReader,
};

pub(in crate::cognition::graph) fn load(
    db: &Connection,
    canonical: &ConversationSourceReader,
    source_root: &Path,
    pinned: &ExtractInput,
    ids: &[String],
    candidate_bytes: usize,
) -> CognitionResult<Vec<ExtractCandidate>> {
    let mut loaded = HashMap::<String, Option<Arc<ExtractCandidate>>>::new();
    let mut selected = HashSet::new();
    let mut result = Vec::new();
    {
        let mut context = CandidateAppendContext {
            db,
            canonical,
            source_root,
            input: pinned,
            loaded: &mut loaded,
            selected: &mut selected,
        };
        for id in ids.iter().take(32) {
            let mut group = Vec::new();
            let mut visiting = HashSet::new();
            if !append(&mut context, id, &mut visiting, &mut group, true)? {
                continue;
            }
            let bytes = crate::json::serde_serialized_bytes(&CandidateSlices(&result, &group))
                .map_err(|_| error("memory_extract_invalid_json"))?;
            if bytes > candidate_bytes {
                continue;
            }
            for candidate in group {
                context.selected.insert(candidate.ref_id.clone());
                result.push(candidate);
            }
        }
    }
    drop(loaded);
    Ok(result.into_iter().map(Arc::unwrap_or_clone).collect())
}

pub(in crate::cognition::graph) fn assert_source_current(
    db: &Connection,
    canonical: &ConversationSourceReader,
    source_root: &Path,
    pinned: &ExtractInput,
    now: &str,
) -> CognitionResult<()> {
    let chunk = db.query_row(
        "SELECT c.current_revision,c.source_key,c.conversation_session_id,c.conversation_turn_id,c.source_hash,j.extraction_version \
         FROM memory_chunks c JOIN memory_projection_jobs j ON j.episode_id=c.memory_chunk_id \
         AND j.revision=c.current_revision WHERE c.memory_chunk_id=?1 LIMIT 1",
        [&pinned.episode_ref],
        |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,Option<String>>(2)?,
            row.get::<_,Option<String>>(3)?,row.get::<_,String>(4)?,row.get::<_,String>(5)?)),
    ).optional().map_err(db_error)?.ok_or_else(source_changed)?;
    if chunk.0 != pinned.revision {
        return Err(source_changed());
    }
    let mut unique_sources = HashSet::new();
    for source in &pinned.source_units {
        if !unique_sources.insert(source.ref_id.as_str()) {
            return Err(source_changed());
        }
        let row = input::source_row(db, &source.ref_id)?.ok_or_else(source_changed)?;
        if row.revision != pinned.revision || row.episode_id != pinned.episode_ref {
            return Err(source_changed());
        }
        if matches!(row.source_kind.as_str(), "task_report" | "explicit_record") {
            hydrate_typed_source(source_root, &row).map_err(|_| source_changed())?;
        } else {
            let message_id = row
                .conversation_message_id
                .as_deref()
                .ok_or_else(source_changed)?;
            let message = canonical
                .read_message(message_id)
                .map_err(|_| source_changed())?
                .ok_or_else(source_changed)?;
            hydrate_conversation_source(&message, &row, f64::INFINITY)
                .map_err(|_| source_changed())?;
        }
    }
    if chunk.1.starts_with("task_report:") || chunk.1.starts_with("explicit_record:") {
        return Ok(());
    }
    let session_id = chunk.2.as_deref().ok_or_else(source_changed)?;
    let notice = if let Some(turn_id) = chunk.3.as_deref() {
        let outcome = canonical
            .read_turn_outcome(turn_id)
            .map_err(|_| source_changed())?
            .ok_or_else(source_changed)?;
        ConversationSourceNotice::Turn {
            session_id,
            turn_id,
            outcome_generation: outcome.generation,
            extraction_version: &chunk.5,
        }
    } else {
        let message_id = chunk
            .1
            .strip_prefix("conversation_message:")
            .ok_or_else(source_changed)?;
        ConversationSourceNotice::Standalone {
            session_id,
            message_id,
            source_hash: &chunk.4,
            extraction_version: &chunk.5,
        }
    };
    assert_conversation_source_current(canonical, notice, &pinned.revision, now)
        .map_err(|_| source_changed())
}

fn source_changed() -> CognitionError {
    error("memory_source_changed")
}
fn error(code: &'static str) -> CognitionError {
    CognitionError::new(code, code)
}
