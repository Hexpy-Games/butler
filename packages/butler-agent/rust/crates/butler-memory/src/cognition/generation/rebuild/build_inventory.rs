//! Verify and enumerate the immutable prepare snapshot before any build work.

use crate::cognition::CognitionCode;
use std::path::Path;

use tokio_util::sync::CancellationToken;

use crate::cognition::{CognitionError, CognitionResult, ensure_data_authority};

use super::inventory;

/// A typed source the build registers, in UTF-16 key order.
#[derive(Clone)]
struct BuildTypedRecord {
    source_kind: String,
    record_id: String,
}

impl BuildTypedRecord {
    fn source_key(&self) -> String {
        format!("{}:{}", self.source_kind, self.record_id)
    }
}

/// The sources a rebuild must register, from its stored inventory.
pub(super) struct BuildInventory {
    /// Sources the rebuild must end with.
    pub(super) expected_source_count: usize,
}

/// Reads the stored inventory of the rebuild candidate and checks it against the snapshot.
pub(super) fn read(
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
        })
        .collect::<Vec<_>>();
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
        expected_source_count: actual.source_count,
    })
}

fn error(code: CognitionCode) -> CognitionError {
    CognitionError::new(code, code.as_str())
}
