//! Direct v2 memory source resolution under a pinned active generation.
//! The caller owns bounded blocking admission; graph and canonical readers are
//! opened only for this operation and drop before the resolved scalar escapes.

use crate::cognition::CognitionCode;
use std::{path::PathBuf, sync::Arc};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};

use crate::cognition::{
    CognitionError, CognitionPathEnvironment, CognitionResult,
    generation::resolve_active_generation,
    graph::GraphRecallReader,
    sources::{RecallSourceHydration, RecallSourceResolution, hydrate_recall_sources},
};
use butler_turn::conversation::{ConversationSourceReader, conversation_store_path};

pub(crate) struct MemorySourceReference {
    data_root: PathBuf,
    paths: CognitionPathEnvironment,
}

pub(crate) struct MemorySourceCandidate {
    pub source_kind: String,
    pub conversation_session_id: Option<String>,
    pub project_id: Option<String>,
    pub origin_kind: String,
}

pub(crate) struct ResolvedMemorySource {
    pub(crate) generation_id: String,
    pub(crate) source_id: String,
    pub(crate) episode_id: String,
    pub(crate) revision: String,
    pub scalar: Arc<str>,
    pub source_hash: String,
    pub source_kind: String,
    pub conversation_session_id: Option<String>,
    pub conversation_message_id: Option<String>,
    pub basis: String,
}

impl MemorySourceReference {
    pub(crate) fn new(data_root: PathBuf, paths: CognitionPathEnvironment) -> Self {
        Self { data_root, paths }
    }

    pub(crate) fn resolve(
        &self,
        handle: &str,
        authorize: impl FnOnce(&MemorySourceCandidate) -> bool,
    ) -> CognitionResult<ResolvedMemorySource> {
        let generation = resolve_active_generation(&self.data_root, &self.paths)?;
        let source_id = decode_handle(handle, &generation.generation_id)?;
        let graph = GraphRecallReader::open(&generation.graph_path)?;
        let mut rows = graph.source_rows(std::slice::from_ref(&source_id))?;
        let row = rows
            .pop()
            .ok_or_else(|| error(CognitionCode::MemorySourceNotFound))?;
        let project_id = graph.source_project_id(&row.episode_id)?;
        let candidate = MemorySourceCandidate {
            source_kind: row.source_kind.clone(),
            conversation_session_id: row.conversation_session_id.clone(),
            project_id,
            origin_kind: row.origin_kind.clone(),
        };
        if !authorize(&candidate) {
            return Err(error(CognitionCode::InvalidScope));
        }
        let canonical = if row.source_kind == "conversation" {
            Some(
                ConversationSourceReader::open(&conversation_store_path(&generation.source_root))
                    .map_err(|source| error(CognitionCode::MemorySourceChanged).with_source(source))?,
            )
        } else {
            None
        };
        // Direct source resolution has no recall episode selection or deadline.
        // Passing an empty episode set avoids recall-only currentness filtering.
        let mut hydrated = hydrate_recall_sources(RecallSourceHydration {
            data_root: &generation.source_root,
            memory_root: &self.paths.memory_root(&self.data_root),
            reader: canonical.as_ref(),
            rows: std::slice::from_ref(&row),
            episodes: &[],
            max_graphemes: usize::MAX,
            deadline_at: i64::MAX,
            now_millis: || 0,
            compare_locale: |a: &str, b: &str| a.cmp(b),
        });
        let Some(RecallSourceResolution::Value(source)) = hydrated.remove(&source_id) else {
            return Err(error(CognitionCode::MemorySourceChanged));
        };
        Ok(ResolvedMemorySource {
            generation_id: generation.generation_id,
            source_id,
            episode_id: row.episode_id,
            revision: row.revision,
            scalar: source.scalar,
            source_hash: source.source_hash,
            source_kind: source.source_kind,
            conversation_session_id: source.conversation_session_id,
            conversation_message_id: source.conversation_message_id,
            basis: source.basis,
        })
    }
}

fn decode_handle(handle: &str, generation_id: &str) -> CognitionResult<String> {
    let parts = handle.split(':').collect::<Vec<_>>();
    let ["memory-source", "v2", generation, source] = parts.as_slice() else {
        return Err(error(CognitionCode::MemorySourceNotFound));
    };
    let decode = |value: &str| {
        URL_SAFE_NO_PAD
            .decode(value)
            .ok()
            .and_then(|bytes| String::from_utf8(bytes).ok())
    };
    let referenced =
        decode(generation).ok_or_else(|| error(CognitionCode::MemorySourceNotFound))?;
    if referenced != generation_id {
        return Err(error(CognitionCode::MemorySourceChanged));
    }
    decode(source).ok_or_else(|| error(CognitionCode::MemorySourceNotFound))
}

fn error(code: CognitionCode) -> CognitionError {
    CognitionError::new(code, code.as_str())
}
