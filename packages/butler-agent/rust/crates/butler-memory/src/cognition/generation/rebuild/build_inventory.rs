//! Verify and enumerate the immutable prepare snapshot before any build work.

use crate::cognition::CognitionCode;
use std::path::Path;

use tokio_util::sync::CancellationToken;

use crate::cognition::{
    CognitionError, CognitionResult, ensure_data_authority, graph::GraphRepository,
};

use super::inventory;

/// A typed source the build registers, in UTF-16 key order.
#[derive(Clone)]
pub struct BuildTypedRecord {
    pub source_kind: String,
    pub record_id: String,
    pub revision: String,
    pub operation_id: String,
    pub content_hash: String,
}

/// A conversation episode the build registers.
#[derive(Clone)]
pub struct BuildConversationRecord {
    pub episode_id: String,
    pub revision: String,
}
impl BuildTypedRecord {
    pub fn source_key(&self) -> String {
        format!("{}:{}", self.source_kind, self.record_id)
    }
}

/// The sources a rebuild must register, from its stored inventory.
pub struct BuildInventory {
    /// Typed records.
    pub typed: Vec<BuildTypedRecord>,
    /// Conversation sources.
    pub conversations: Vec<BuildConversationRecord>,
    /// Sources the rebuild must end with.
    pub expected_source_count: usize,
}

/// Reads the stored inventory of the rebuild candidate and checks it against the snapshot.
pub fn read(
    data_root: &Path,
    handle: &crate::cognition::MemoryGenerationHandle,
    cancellation: &CancellationToken,
) -> CognitionResult<BuildInventory> {
    if cancellation.is_cancelled() {
        return Err(error(CognitionCode::MemoryOperationAborted));
    }
    let stored_path = handle.source_root.join("memory-source-inventory.json");
    let canonical = handle
        .canonical_snapshot_path
        .as_ref()
        .ok_or_else(|| error(CognitionCode::MemorySnapshotChanged))?;
    let manifest_path = handle.root.join("manifest.json");
    ensure_data_authority(
        data_root,
        &[&handle.source_root, canonical, &stored_path, &manifest_path],
    )?;
    let stored = inventory::MemorySourceInventory::read(&stored_path)?;
    let actual = inventory::read(&handle.source_root, canonical, &stored.as_of, cancellation)?;
    let manifest = crate::cognition::generation::manifest::GenerationManifest::read(
        &manifest_path,
        CognitionCode::MemorySnapshotChanged,
    )?;
    if actual.inventory != stored
        || manifest.source_inventory_hash.as_deref() != Some(actual.hash.as_str())
    {
        return Err(error(CognitionCode::MemorySourceChanged));
    }
    let mut typed = stored
        .typed
        .into_iter()
        .map(|entry| BuildTypedRecord {
            source_kind: entry.source_kind,
            record_id: entry.record_id,
            revision: entry.revision,
            operation_id: entry.operation_id,
            content_hash: entry.content_hash,
        })
        .collect::<Vec<_>>();
    let conversations = stored
        .entries
        .into_iter()
        .map(|entry| BuildConversationRecord {
            episode_id: entry.episode_id,
            revision: entry.revision,
        })
        .collect();
    typed.sort_by(|left, right| {
        let left_key = left.source_key();
        let right_key = right.source_key();
        left_key.encode_utf16().cmp(right_key.encode_utf16())
    });
    if typed
        .windows(2)
        .any(|pair| matches!(pair, [left, right] if left.source_key() == right.source_key()))
    {
        return Err(error(CognitionCode::MemorySnapshotChanged));
    }
    Ok(BuildInventory {
        typed,
        conversations,
        expected_source_count: actual.source_count,
    })
}

/// Checks every inventoried source is registered in the candidate graph.
pub fn assert_registered(
    handle: &crate::cognition::MemoryGenerationHandle,
    inventory: &BuildInventory,
) -> CognitionResult<()> {
    use rusqlite::{Connection, OptionalExtension, params};
    let connection = Connection::open_with_flags(
        &handle.graph_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|source| error(CognitionCode::MemoryGenerationUnavailable).with_source(source))?;
    for entry in &inventory.conversations {
        let exists = connection.query_row(
            "SELECT 1 FROM memory_chunks c JOIN memory_projection_jobs j ON j.episode_id=c.memory_chunk_id AND j.revision=c.current_revision \
             WHERE c.memory_chunk_id=?1 AND c.current_revision=?2 LIMIT 1",
            params![entry.episode_id, entry.revision], |_| Ok(()),
        ).optional().map_err(|source| error(CognitionCode::MemoryGenerationUnavailable).with_source(source))?;
        if exists.is_none() {
            return Err(error(CognitionCode::MemoryRebuildSourcesIncomplete));
        }
    }
    for record in &inventory.typed {
        let key = record.source_key();
        let exists = connection.query_row(
            "SELECT 1 FROM memory_chunks c JOIN memory_projection_jobs j ON j.episode_id=c.memory_chunk_id AND j.revision=c.current_revision \
             WHERE c.source_key=?1 AND c.current_revision=?2 LIMIT 1",
            params![key, record.revision], |_| Ok(()),
        ).optional().map_err(|source| error(CognitionCode::MemoryGenerationUnavailable).with_source(source))?;
        if exists.is_none() {
            return Err(error(CognitionCode::MemoryRebuildSourcesIncomplete));
        }
    }
    connection.close().map_err(|(_, source)| {
        error(CognitionCode::MemoryGenerationUnavailable).with_source(source)
    })
}

/// The candidate's typed registration cursor for the snapshot.
pub fn typed_cursor(
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

fn error(code: CognitionCode) -> CognitionError {
    CognitionError::new(code, code.as_str())
}
