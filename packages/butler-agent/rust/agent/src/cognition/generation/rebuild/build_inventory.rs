//! Verify and enumerate the immutable prepare snapshot before any build work.

use std::{fs, path::Path};

use serde::Deserialize;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::cognition::{
    CognitionError, CognitionResult, ensure_data_authority, graph::GraphRepository,
};

use super::inventory;

#[derive(Clone, Deserialize)]
pub(crate) struct BuildTypedRecord {
    pub source_kind: String,
    pub record_id: String,
    pub revision: String,
    pub operation_id: String,
    pub content_hash: String,
}

#[derive(Clone, Deserialize)]
pub(crate) struct BuildConversationRecord {
    #[serde(rename = "episodeId")]
    pub episode_id: String,
    pub revision: String,
}
impl BuildTypedRecord {
    pub(crate) fn source_key(&self) -> String {
        format!("{}:{}", self.source_kind, self.record_id)
    }
}

pub(crate) struct BuildInventory {
    pub typed: Vec<BuildTypedRecord>,
    pub conversations: Vec<BuildConversationRecord>,
    pub expected_source_count: usize,
}

pub(crate) fn read(
    data_root: &Path,
    handle: &crate::cognition::MemoryGenerationHandle,
    cancellation: &CancellationToken,
) -> CognitionResult<BuildInventory> {
    if cancellation.is_cancelled() {
        return Err(error("memory_operation_aborted"));
    }
    let stored_path = handle.source_root.join("memory-source-inventory.json");
    let canonical = handle
        .canonical_snapshot_path
        .as_ref()
        .ok_or_else(|| error("memory_snapshot_changed"))?;
    let manifest_path = handle.root.join("manifest.json");
    ensure_data_authority(
        data_root,
        &[&handle.source_root, canonical, &stored_path, &manifest_path],
    )?;
    let stored: Value = serde_json::from_slice(
        &fs::read(&stored_path).map_err(|_| error("memory_snapshot_changed"))?,
    )
    .map_err(|_| error("memory_snapshot_changed"))?;
    if stored["schema"] != "butler.memory-source-inventory.v1" {
        return Err(error("memory_snapshot_changed"));
    }
    let as_of = stored["as_of"]
        .as_str()
        .ok_or_else(|| error("memory_snapshot_changed"))?;
    let actual = inventory::read(&handle.source_root, canonical, as_of, cancellation)?;
    let manifest: Value = serde_json::from_slice(
        &fs::read(&manifest_path).map_err(|_| error("memory_snapshot_changed"))?,
    )
    .map_err(|_| error("memory_snapshot_changed"))?;
    if actual.value != stored || manifest["source_inventory_hash"] != actual.hash {
        return Err(error("memory_source_changed"));
    }
    let mut typed = serde_json::from_value::<Vec<BuildTypedRecord>>(stored["typed"].clone())
        .map_err(|_| error("memory_snapshot_changed"))?;
    let conversations =
        serde_json::from_value::<Vec<BuildConversationRecord>>(stored["entries"].clone())
            .map_err(|_| error("memory_snapshot_changed"))?;
    typed.sort_by(|left, right| {
        let left_key = left.source_key();
        let right_key = right.source_key();
        left_key.encode_utf16().cmp(right_key.encode_utf16())
    });
    for pair in typed.windows(2) {
        if pair[0].source_key() == pair[1].source_key() {
            return Err(error("memory_snapshot_changed"));
        }
    }
    Ok(BuildInventory {
        typed,
        conversations,
        expected_source_count: actual.source_count,
    })
}

pub(crate) fn assert_registered(
    handle: &crate::cognition::MemoryGenerationHandle,
    inventory: &BuildInventory,
) -> CognitionResult<()> {
    use rusqlite::{Connection, OptionalExtension, params};
    let connection = Connection::open_with_flags(
        &handle.graph_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|_| error("memory_generation_unavailable"))?;
    for entry in &inventory.conversations {
        let exists = connection.query_row(
            "SELECT 1 FROM memory_chunks c JOIN memory_projection_jobs j ON j.episode_id=c.memory_chunk_id AND j.revision=c.current_revision \
             WHERE c.memory_chunk_id=?1 AND c.current_revision=?2 LIMIT 1",
            params![entry.episode_id, entry.revision], |_| Ok(()),
        ).optional().map_err(|_| error("memory_generation_unavailable"))?;
        if exists.is_none() {
            return Err(error("memory_rebuild_sources_incomplete"));
        }
    }
    for record in &inventory.typed {
        let key = record.source_key();
        let exists = connection.query_row(
            "SELECT 1 FROM memory_chunks c JOIN memory_projection_jobs j ON j.episode_id=c.memory_chunk_id AND j.revision=c.current_revision \
             WHERE c.source_key=?1 AND c.current_revision=?2 LIMIT 1",
            params![key, record.revision], |_| Ok(()),
        ).optional().map_err(|_| error("memory_generation_unavailable"))?;
        if exists.is_none() {
            return Err(error("memory_rebuild_sources_incomplete"));
        }
    }
    connection
        .close()
        .map_err(|_| error("memory_generation_unavailable"))
}

pub(crate) fn typed_cursor(
    handle: &crate::cognition::MemoryGenerationHandle,
    snapshot_id: &str,
) -> CognitionResult<Option<String>> {
    let graph = GraphRepository::open(&handle.graph_path)?;
    let cursor = graph.rebuild_typed_cursor(snapshot_id);
    let closed = graph.close();
    cursor.and_then(|value| {
        closed?;
        Ok(value)
    })
}

fn error(code: &'static str) -> CognitionError {
    CognitionError::new(code, code)
}
