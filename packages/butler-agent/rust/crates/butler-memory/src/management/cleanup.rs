//! Conservative cleanup under the shared lease. Valid generations remain readable
//! by retained candidate/rollback APIs, so this phase keeps them all.
use super::{measurement::files, safety};
use crate::{
    cognition::CognitionPathEnvironment,
    coordination::{CognitionWriteAcquire, CognitionWriteCoordinator},
};
use serde::{Deserialize, Serialize};
use std::{fs, io, path::Path, sync::Arc};
use tokio_util::sync::CancellationToken;
pub(super) mod plan;
mod trash;

/// One artifact outcome; paths are relative names, never memory content.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CleanupItem {
    /// Relative path within the memory root.
    pub name: String,
    /// Physical allocation; unknown on unsupported platforms.
    pub allocated_bytes: Option<u64>,
    /// `kept`, `renamed`, or `removed`.
    pub outcome: String,
    /// Eligibility or keep reason.
    pub reason: String,
}

/// Durable, sequenced operation receipt. It contains no memory text.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CleanupResult {
    /// Client-provided UUID for idempotency.
    pub operation_id: String,
    /// Requested inventory revision, preserved across restarts.
    pub inventory_revision: u64,
    /// `preparing`, `removing`, `complete`, `cancelled`, or `failed`.
    pub phase: String,
    /// Monotonically increasing event sequence for reconnect deduplication.
    pub sequence: u64,
    /// Confirmed physically unlinked allocation.
    pub bytes_reclaimed: u64,
    /// Every analyzed artifact and its disposition.
    pub items: Vec<CleanupItem>,
}

pub(super) fn receipt(root: &Path, id: &str) -> io::Result<Option<CleanupResult>> {
    validate_id(id)?;
    let path = root
        .join("management/operations")
        .join(id)
        .join("receipt.json");
    crate::cognition::ensure_data_authority(root, &[&path]).map_err(io::Error::other)?;
    match fs::read(path) {
        Ok(bytes) => {
            let result: CleanupResult = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
            if result.operation_id != id {
                return Err(io::Error::other("Receipt identity mismatch"));
            }
            Ok(Some(result))
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

pub(super) fn validate_id(id: &str) -> io::Result<()> {
    if uuid::Uuid::parse_str(id).is_ok_and(|u| u.to_string() == id) {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Invalid operation ID",
        ))
    }
}

pub(super) fn run(
    binding: (
        &Path,
        &CognitionPathEnvironment,
        &Arc<CognitionWriteCoordinator>,
    ),
    id: &str,
    revision: u64,
    token: &CancellationToken,
    publish: &dyn Fn(CleanupResult),
) -> io::Result<CleanupResult> {
    let (root, paths, coordinator) = binding;
    safety::validate(root, paths)?;
    validate_id(id)?;
    let memory = paths.memory_root(root);
    if let Some(saved) = receipt(&memory, id)? {
        if saved.inventory_revision != revision {
            return Err(io::Error::other("Operation ID conflicts"));
        }
        if saved.phase == "complete" {
            return Ok(saved);
        }
    } else if coordinator.inventory_revision() != revision {
        return Err(io::Error::other("Inventory changed"));
    }
    let mut result = receipt(&memory, id)?.unwrap_or(CleanupResult {
        operation_id: id.into(),
        inventory_revision: revision,
        phase: "preparing".into(),
        sequence: 0,
        bytes_reclaimed: 0,
        items: vec![],
    });
    if let Err(error) = safety::cancelled(token) {
        result.phase = "cancelled".into();
        save(&memory, &mut result, publish)?;
        return Err(error);
    }
    let lease = coordinator
        .try_acquire(&CognitionWriteAcquire::immediate(
            paths.consolidation_lock(root),
            "memory_cleanup",
        ))
        .map_err(io::Error::other)?;
    let Some(lease) = lease else {
        result.phase = "failed".into();
        save(&memory, &mut result, publish)?;
        return Err(io::Error::other("Memory is in use"));
    };
    result.phase = "preparing".into();
    let outcome = execute(root, paths, &mut result, token, publish);
    if let Err(error) = &outcome {
        result.phase = if error.kind() == io::ErrorKind::Interrupted {
            "cancelled"
        } else {
            "failed"
        }
        .into();
        save(&memory, &mut result, publish)?;
    }
    lease.release(false).map_err(io::Error::other)?;
    outcome.map(|()| result)
}

fn execute(
    root: &Path,
    paths: &CognitionPathEnvironment,
    result: &mut CleanupResult,
    token: &CancellationToken,
    publish: &dyn Fn(CleanupResult),
) -> io::Result<()> {
    let memory = paths.memory_root(root);
    // Validate serving authority before even creating the receipt or trash.
    let handle = super::safety::active(root, paths)?;
    if handle.root != memory.join("generations").join(&handle.generation_id) {
        return Err(io::Error::other("Active v2 generation is required"));
    }
    let descriptor = fs::read(memory.join("active-generation.json"))?;
    let manifest = fs::read(handle.root.join("manifest.json"))?;
    save(&memory, result, publish)?;
    trash::finish_prior(&memory, result, token, publish)?;
    let candidates = plan::analyze(
        &memory,
        &handle.generation_id,
        &descriptor,
        &manifest,
        token,
    )?;
    for candidate in candidates {
        safety::cancelled(token)?;
        if candidate.reason == "unpublished_empty_generation" {
            remove_empty(
                &memory,
                (&descriptor, &manifest, &handle.root),
                candidate,
                result,
                token,
                publish,
            )?;
        } else {
            result.items.push(candidate);
        }
    }
    result.phase = "complete".into();
    save(&memory, result, publish)
}

fn remove_empty(
    memory: &Path,
    protected: (&[u8], &[u8], &Path),
    mut item: CleanupItem,
    result: &mut CleanupResult,
    token: &CancellationToken,
    publish: &dyn Fn(CleanupResult),
) -> io::Result<()> {
    let (descriptor, manifest, active) = protected;
    let source = memory.join(&item.name);
    if fs::read_dir(&source)?.next().is_some() {
        item.reason = "artifact_changed".into();
        result.items.push(item);
        return Ok(());
    }
    let trash = memory
        .join("management/operations")
        .join(&result.operation_id)
        .join("trash");
    butler_platform::secure_fs::create_private_dir_all(&trash)?;
    result.phase = "removing".into();
    item.outcome = "renamed".into();
    result.items.push(item);
    // Persist the exact source and allocation before the rename for crash reconciliation.
    save(memory, result, publish)?;
    let index = result.items.len().saturating_sub(1);
    let destination = trash.join(index.to_string());
    // Recheck after the durable intent write, immediately before the rename.
    if fs::read(memory.join("active-generation.json"))? != descriptor
        || fs::read(active.join("manifest.json"))? != manifest
    {
        if let Some(item) = result.items.get_mut(index) {
            item.outcome = "kept".into();
            item.reason = "active_descriptor_changed".into();
        }
        return Err(io::Error::other("Memory changed"));
    }
    if let Err(_error) = butler_platform::secure_fs::rename(&source, &destination) {
        if let Some(item) = result.items.get_mut(index) {
            item.outcome = "kept".into();
            item.reason = "in_use_or_rename_failed".into();
        }
        return save(memory, result, publish);
    }
    butler_platform::secure_fs::sync_path(source.parent().unwrap_or(memory))?;
    butler_platform::secure_fs::sync_path(&trash)?;
    safety::cancelled(token)?;
    trash::finish_item(memory, result, index, token)?;
    save(memory, result, publish)
}

pub(super) fn save(
    memory: &Path,
    result: &mut CleanupResult,
    publish: &dyn Fn(CleanupResult),
) -> io::Result<()> {
    let directory = memory
        .join("management/operations")
        .join(&result.operation_id);
    crate::cognition::ensure_data_authority(memory, &[&directory]).map_err(io::Error::other)?;
    butler_platform::secure_fs::create_private_dir_all(&directory)?;
    result.sequence += 1;
    let bytes = serde_json::to_vec(result).map_err(io::Error::other)?;
    butler_platform::secure_fs::replace_private(
        &directory.join("receipt.json"),
        |file| {
            use std::io::Write;
            file.write_all(&bytes)
        },
        |error| error,
    )?;
    publish(result.clone());
    Ok(())
}

pub(super) fn begin(
    root: &Path,
    paths: &CognitionPathEnvironment,
    coordinator: &CognitionWriteCoordinator,
    id: &str,
    revision: u64,
) -> io::Result<CleanupResult> {
    safety::validate(root, paths)?;
    validate_id(id)?;
    let memory = paths.memory_root(root);
    if let Some(result) = receipt(&memory, id)? {
        if result.inventory_revision != revision {
            return Err(io::Error::other("Operation ID conflicts"));
        }
        return Ok(result);
    }
    if coordinator.inventory_revision() != revision {
        return Err(io::Error::other("Inventory changed"));
    }
    let handle = super::safety::active(root, paths)?;
    if handle.root != memory.join("generations").join(&handle.generation_id) {
        return Err(io::Error::other("Active v2 generation is required"));
    }
    let lease = coordinator
        .try_acquire(&CognitionWriteAcquire::immediate(
            paths.consolidation_lock(root),
            "memory_cleanup_accept",
        ))
        .map_err(io::Error::other)?
        .ok_or_else(|| io::Error::other("Memory is in use"))?;
    if coordinator.inventory_revision() != revision.saturating_add(1) {
        lease.release(false).map_err(io::Error::other)?;
        return Err(io::Error::other("Inventory changed"));
    }
    let mut result = CleanupResult {
        operation_id: id.into(),
        inventory_revision: revision,
        phase: "preparing".into(),
        sequence: 0,
        bytes_reclaimed: 0,
        items: vec![],
    };
    save(&memory, &mut result, &|_| {})?;
    lease.release(false).map_err(io::Error::other)?;
    Ok(result)
}
