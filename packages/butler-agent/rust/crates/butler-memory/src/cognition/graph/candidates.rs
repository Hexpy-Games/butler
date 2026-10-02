//! Current-generation source-window candidates for semantic binding.

use crate::cognition::CognitionCode;
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
mod hydration;
mod selection;

pub(super) use hydration::assert_current;
use hydration::hydrate;

use rusqlite::{Connection, params};
use serde::{Serialize, Serializer, ser::SerializeSeq};

use super::db_error;
use crate::cognition::extraction::{ExtractCandidate, ExtractInput};
use crate::cognition::{CognitionError, CognitionResult};
use butler_turn::conversation::ConversationSourceReader;

pub(super) fn load(
    db: &Connection,
    canonical: &ConversationSourceReader,
    source_root: &Path,
    input: &ExtractInput,
    cue: &str,
    vector: &[VectorHit],
    deadline: i64,
) -> CognitionResult<Vec<ExtractCandidate>> {
    if cue.len() > 8_192 {
        return Err(error(CognitionCode::MemoryExtractSourceWindowExceedsBudget));
    }
    let seeds = selection::select(db, canonical, input, cue, vector, deadline)?;
    let mut ids = Vec::new();
    let mut seen = HashSet::new();
    let mut bound = db
        .prepare(
            "SELECT DISTINCT node_id
             FROM memory_evidence
             WHERE episode_id = ?1 AND revision = ?2
             ORDER BY node_id
             LIMIT 8",
        )
        .map_err(db_error)?;
    for row in bound
        .query_map(params![input.episode_ref, input.revision], |r| {
            r.get::<_, String>(0)
        })
        .map_err(db_error)?
    {
        let id = row.map_err(db_error)?;
        if seen.insert(id.clone()) {
            ids.push(id);
        }
    }
    for id in seeds.all_seeds {
        if seen.insert(id.clone()) {
            ids.push(id);
        }
    }
    let mut loaded = HashMap::<String, Option<Arc<ExtractCandidate>>>::new();
    let mut selected = HashSet::new();
    let mut result = Vec::new();
    {
        let mut context = CandidateAppendContext {
            db,
            canonical,
            source_root,
            input,
            loaded: &mut loaded,
            selected: &mut selected,
        };
        for id in ids.into_iter().take(32) {
            let mut group = Vec::new();
            let mut visiting = HashSet::new();
            if !append(
                &mut context,
                &id,
                &mut visiting,
                &mut group,
                AliasSources::AllOwners,
            )? {
                continue;
            }
            let next_bytes =
                butler_core::json::serde_serialized_bytes(&CandidateSlices(&result, &group))
                    .map_err(json_error)?;
            if next_bytes > 8_192 {
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

struct CandidateSlices<'a>(&'a [Arc<ExtractCandidate>], &'a [Arc<ExtractCandidate>]);
impl Serialize for CandidateSlices<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut seq = serializer.serialize_seq(Some(self.0.len() + self.1.len()))?;
        for candidate in self.0.iter().chain(self.1) {
            seq.serialize_element(candidate.as_ref())?;
        }
        seq.end()
    }
}

#[derive(Clone, Debug)]
pub struct VectorHit {
    pub owner_id: String,
    pub rank: usize,
    pub distance: f64,
}

/// Which sources a candidate's aliases may be quoted from.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum AliasSources {
    /// Public conversation text only.
    Conversation,
    /// Conversation text, reviewed task reports and explicit rules.
    AllOwners,
}

pub(super) struct CandidateAppendContext<'a> {
    db: &'a Connection,
    canonical: &'a ConversationSourceReader,
    source_root: &'a Path,
    input: &'a ExtractInput,
    loaded: &'a mut HashMap<String, Option<Arc<ExtractCandidate>>>,
    selected: &'a mut HashSet<String>,
}

fn append(
    context: &mut CandidateAppendContext<'_>,
    id: &str,
    visiting: &mut HashSet<String>,
    group: &mut Vec<Arc<ExtractCandidate>>,
    sources: AliasSources,
) -> CognitionResult<bool> {
    if context.selected.contains(id) || group.iter().any(|c| c.ref_id == id) {
        return Ok(true);
    }
    if visiting.contains(id) || context.selected.len() + group.len() + visiting.len() >= 32 {
        return Ok(false);
    }
    if !context.loaded.contains_key(id) {
        if context.loaded.len() >= 96 {
            return Ok(false);
        }
        context.loaded.insert(
            id.to_owned(),
            hydrate(
                context.db,
                context.canonical,
                context.source_root,
                context.input,
                id,
                sources,
            )?
            .map(Arc::new),
        );
    }
    let Some(candidate) = context.loaded.get(id).cloned().flatten() else {
        return Ok(false);
    };
    visiting.insert(id.to_owned());
    let endpoints = candidate
        .claim
        .as_ref()
        .map(|claim| [claim.subject_ref.as_deref(), claim.object_ref.as_deref()])
        .unwrap_or_default();
    for id in endpoints.into_iter().flatten() {
        if !append(context, id, visiting, group, sources)? {
            visiting.remove(&candidate.ref_id);
            return Ok(false);
        }
    }
    visiting.remove(&candidate.ref_id);
    group.push(candidate);
    Ok(true)
}

fn current_millis() -> i64 {
    i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    )
    .unwrap_or(i64::MAX)
}
fn error(code: CognitionCode) -> CognitionError {
    CognitionError::new(code, code.as_str())
}
fn json_error(error: impl std::error::Error + Send + Sync + 'static) -> CognitionError {
    CognitionError::new(CognitionCode::MemoryExtractInvalidJson, error.to_string())
        .with_source(error)
}
