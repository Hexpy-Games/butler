//! Future-only conversation reset by staging the shared graph's surviving projection.
mod cache;
mod retirement;
mod settlement;
mod survivors;
mod vectors;
use super::{MemoryGenerationHandle, ProjectionMode, resolve_active_generation, swap};
use crate::{
    cognition::CognitionPathEnvironment,
    coordination::{CognitionWriteAcquire, CognitionWriteCoordinator},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs, io,
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio_util::sync::CancellationToken;

/// Durable reset receipt; completion and reclamation are independent.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ResetResult {
    /// Client operation identity, also the new generation identity.
    pub operation_id: String,
    /// Selected owner kind.
    pub kind: String,
    /// Selected project; absent for all conversation memory.
    pub project_id: Option<String>,
    /// Inventory revision accepted by the reset.
    pub inventory_revision: u64,
    /// Serving generation captured before the reset.
    pub old_generation: String,
    /// `preparing`, `complete`, `cancelled` or `failed`.
    pub phase: String,
    /// Sequenced durable transition for events/reconnect.
    pub sequence: u64,
    /// Whether the old directory remains pending reader drain/removal.
    pub removal_pending: bool,
    /// Instruction owner targets captured when a project reset is accepted.
    #[serde(default)]
    pub instructions: Vec<crate::cognition::RememberedRuleTarget>,
}

pub(crate) use accept::begin;
mod accept;

pub(crate) async fn run(
    root: PathBuf,
    paths: CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    id: String,
    token: CancellationToken,
) -> io::Result<ResetResult> {
    let binding = (root.clone(), paths.clone(), id.clone());
    let mut result = tokio::task::spawn_blocking(move || {
        receipt(&binding.0, &binding.1, &binding.2)?
            .ok_or_else(|| io::Error::other("Reset receipt is missing"))
    })
    .await
    .map_err(io::Error::other)??;
    if result.phase == "complete" {
        if result.removal_pending {
            retirement::retire(root, paths, coordinator, result.clone(), token);
        }
        return Ok(result);
    }
    let lease = acquire(&root, &paths, &coordinator, &token).await?;
    let prepared = prepare(root.clone(), paths.clone(), result.clone(), token.clone()).await;
    let outcome = match prepared {
        Ok(Some((old, new))) => {
            let binding = (root.clone(), paths.clone(), result.clone(), token.clone());
            tokio::task::spawn_blocking(move || {
                commit(
                    &binding.0, &binding.1, lease, &binding.2, &old, &new, &binding.3,
                )
            })
            .await
            .map_err(io::Error::other)?
        }
        Ok(None) => {
            lease.release(false).map_err(io::Error::other)?;
            Ok(())
        }
        Err(error) => {
            lease.release(false).map_err(io::Error::other)?;
            Err(error)
        }
    };
    let binding = (root.clone(), paths.clone(), result.operation_id.clone());
    let committed = tokio::task::spawn_blocking(move || {
        resolve_active_generation(&binding.0, &binding.1)
            .is_ok_and(|active| active.generation_id == binding.2)
    })
    .await
    .map_err(io::Error::other)?;
    if let Err(error) = outcome
        && !committed
    {
        // A project reset may already have committed instruction-owner forgets.
        // Keep its intent resumable until the shared projection also commits.
        result.phase = failed_phase(&result, &token).into();
        result.sequence += 1;
        butler_core::diagnostic!(
            "[memory-reset] operation_id={} phase={} error={error}",
            result.operation_id,
            result.phase
        );
        let binding = (root, paths, result);
        tokio::task::spawn_blocking(move || {
            save_leased(&binding.0, &binding.1, &coordinator, &binding.2)
        })
        .await
        .map_err(io::Error::other)??;
        return Err(error);
    }
    result.phase = "complete".into();
    result.sequence += 1;
    result.removal_pending = true;
    settlement::test_gate(&root, &token).await?;
    let binding = (root.clone(), paths.clone(), result.clone());
    save_completion(binding, coordinator.clone(), token.clone()).await?;
    retirement::retire(root, paths, coordinator, result.clone(), token);
    Ok(result)
}

// The cutover releases its lease before the durable completion receipt. A
// source consumer may acquire it in between; settlement waits under the existing
// coordinator budget rather than abandoning the accepted reset as preparing.
async fn save_completion(
    binding: (PathBuf, CognitionPathEnvironment, ResetResult),
    coordinator: Arc<CognitionWriteCoordinator>,
    token: CancellationToken,
) -> io::Result<()> {
    butler_core::diagnostic!(
        "[memory-reset-settlement] operation_id={} phase=acquiring",
        binding.2.operation_id
    );
    let lease = acquire(&binding.0, &binding.1, &coordinator, &token).await?;
    tokio::task::spawn_blocking(move || {
        let saved = check(&token).and_then(|()| save(&binding.0, &binding.1, &binding.2));
        lease.release(saved.is_ok()).map_err(io::Error::other)?;
        if saved.is_ok() {
            butler_core::diagnostic!(
                "[memory-reset-settlement] operation_id={} phase=saved",
                binding.2.operation_id
            );
        }
        saved
    })
    .await
    .map_err(io::Error::other)?
}

fn failed_phase(result: &ResetResult, token: &CancellationToken) -> &'static str {
    if result.project_id.is_some() {
        "preparing"
    } else if token.is_cancelled() {
        "cancelled"
    } else {
        "failed"
    }
}

async fn prepare(
    root: PathBuf,
    paths: CognitionPathEnvironment,
    result: ResetResult,
    token: CancellationToken,
) -> io::Result<Option<(MemoryGenerationHandle, PathBuf)>> {
    let binding = (root.clone(), paths.clone(), result.clone(), token.clone());
    let staged =
        tokio::task::spawn_blocking(move || stage(&binding.0, &binding.1, &binding.2, &binding.3))
            .await
            .map_err(io::Error::other)??;
    let Some((old, new)) = staged else {
        return Ok(None);
    };
    vectors::copy(
        &old.root,
        &new,
        &new.join("graph.sqlite"),
        &result.operation_id,
        &token,
    )
    .await?;
    Ok(Some((old, new)))
}

fn stage(
    root: &Path,
    paths: &CognitionPathEnvironment,
    result: &ResetResult,
    token: &CancellationToken,
) -> io::Result<Option<(MemoryGenerationHandle, PathBuf)>> {
    validate(root, paths, &result.operation_id)?;
    check(token)?;
    let old = resolve_active_generation(root, paths).map_err(io::Error::other)?;
    crate::coordination::ensure_data_authority(root, &[&old.root, &old.graph_path])?;
    if old.generation_id == result.operation_id {
        return Ok(None);
    }
    if old.generation_id != result.old_generation {
        return Err(io::Error::other("Memory changed"));
    }
    let new = paths
        .memory_root(root)
        .join("generations")
        .join(&result.operation_id);
    crate::cognition::ensure_data_authority(root, &[&new]).map_err(io::Error::other)?;
    if new.exists() {
        retirement::remove_tree(root, &new, token)?;
    }
    butler_platform::secure_fs::create_private_dir_all(&new)?;
    let mut manifest: Value = serde_json::from_slice(&fs::read(old.root.join("manifest.json"))?)
        .map_err(io::Error::other)?;
    let object = manifest
        .as_object_mut()
        .ok_or_else(|| io::Error::other("Generation manifest is unavailable"))?;
    for name in [
        "canonical_snapshot_id",
        "canonical_snapshot_path",
        "canonical_snapshot",
        "source_inventory_hash",
        "readiness",
        "acceptance_binding",
    ] {
        object.remove(name);
    }
    object.insert("generation_id".into(), json!(result.operation_id));
    object.insert("state".into(), json!("active"));
    object.insert("reset_operation_id".into(), json!(result.operation_id));
    write_json(&new.join("manifest.json"), &manifest)?;
    swap::vacuum_snapshot_cancellable(&old.graph_path, &new.join("graph.sqlite"), token)
        .map_err(io::Error::other)?;
    survivors::prune(
        root,
        &new.join("graph.sqlite"),
        result.project_id.as_deref(),
        &result.operation_id,
        token,
    )?;
    cache::copy(&old.root, &new)?;
    Ok(Some((old, new)))
}

fn commit(
    root: &Path,
    paths: &CognitionPathEnvironment,
    lease: crate::coordination::CognitionWriteLease,
    result: &ResetResult,
    old: &MemoryGenerationHandle,
    new: &Path,
    token: &CancellationToken,
) -> io::Result<()> {
    check(token)?;
    sync_tree(new, token)?;
    let captured = swap::capture_active_descriptor(root, paths).map_err(io::Error::other)?;
    if captured.fields.generation_id != old.generation_id {
        return Err(io::Error::other("Memory changed"));
    }
    let manifest = fs::read(new.join("manifest.json"))?;
    let hash = format!("{:x}", Sha256::digest(&manifest));
    let mut next = swap::next_descriptor(
        &result.operation_id,
        &old.generation_id,
        &chrono::Utc::now().to_rfc3339(),
        ProjectionMode::Running,
    );
    next.previous_generation_id = None;
    let guard = swap::TransitionGuard {
        expected: &captured,
        target_generation_id: &result.operation_id,
        target_manifest_sha256: &hash,
    };
    if let Some(project) = result.project_id.as_deref() {
        let capsule = crate::cognition::capsule_path(&paths.memory_root(root), project);
        crate::cognition::ensure_data_authority(root, &[&capsule]).map_err(io::Error::other)?;
        if capsule.exists() {
            fs::remove_file(&capsule)?;
            butler_platform::secure_fs::sync_path(
                capsule
                    .parent()
                    .ok_or_else(|| io::Error::other("Invalid capsule path"))?,
            )?;
        }
    }
    swap::commit_descriptor_transition(root, paths, &lease, &guard, &next)
        .map_err(io::Error::other)?;
    lease.release(true).map_err(io::Error::other)?;
    Ok(())
}

pub(crate) fn receipt(
    root: &Path,
    paths: &CognitionPathEnvironment,
    id: &str,
) -> io::Result<Option<ResetResult>> {
    validate(root, paths, id)?;
    let path = receipt_path(root, paths, id);
    crate::coordination::ensure_data_authority(root, &[&path])?;
    match fs::read(path) {
        Ok(bytes) => {
            let result: ResetResult = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
            if result.operation_id != id
                || !uuid::Uuid::parse_str(&result.old_generation)
                    .is_ok_and(|value| value.to_string() == result.old_generation)
            {
                return Err(io::Error::other("Reset receipt identity mismatch"));
            }
            Ok(Some(result))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}
fn receipt_path(root: &Path, paths: &CognitionPathEnvironment, id: &str) -> PathBuf {
    paths
        .memory_root(root)
        .join("management/resets")
        .join(id)
        .join("receipt.json")
}
pub(crate) fn save(
    root: &Path,
    paths: &CognitionPathEnvironment,
    result: &ResetResult,
) -> io::Result<()> {
    let path = receipt_path(root, paths, &result.operation_id);
    crate::coordination::ensure_data_authority(root, &[&path])?;
    write_json(
        &path,
        &serde_json::to_value(result).map_err(io::Error::other)?,
    )
}
fn write_json(path: &Path, value: &Value) -> io::Result<()> {
    butler_platform::secure_fs::create_private_dir_all(
        path.parent()
            .ok_or_else(|| io::Error::other("Invalid reset path"))?,
    )?;
    butler_platform::secure_fs::replace_private(
        path,
        |file| file.write_all(value.to_string().as_bytes()),
        |error| error,
    )
}
fn validate(root: &Path, paths: &CognitionPathEnvironment, id: &str) -> io::Result<()> {
    if !uuid::Uuid::parse_str(id).is_ok_and(|id_value| id_value.to_string() == id) {
        return Err(io::Error::other("Invalid operation ID"));
    }
    crate::coordination::ensure_supported_data_authority(
        root,
        &[
            &paths.memory_root(root),
            &paths.cognition_root(root),
            &paths.consolidation_lock(root),
        ],
    )
}
fn check(token: &CancellationToken) -> io::Result<()> {
    if token.is_cancelled() {
        return Err(io::Error::new(io::ErrorKind::Interrupted, "Cancelled"));
    }
    Ok(())
}
fn sync_tree(root: &Path, token: &CancellationToken) -> io::Result<()> {
    check(token)?;
    for entry in fs::read_dir(root)? {
        let path = entry?.path();
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.is_symlink() {
            return Err(io::Error::other("Linked staging artifact"));
        }
        if metadata.is_dir() {
            sync_tree(&path, token)?;
        } else {
            butler_platform::secure_fs::sync_path(&path)?;
        }
    }
    butler_platform::secure_fs::sync_path(root)
}

pub(crate) fn save_leased(
    root: &Path,
    paths: &CognitionPathEnvironment,
    coordinator: &CognitionWriteCoordinator,
    result: &ResetResult,
) -> io::Result<()> {
    validate(root, paths, &result.operation_id)?;
    let lease = coordinator
        .try_acquire(&CognitionWriteAcquire::immediate(
            paths.consolidation_lock(root),
            "reset_receipt",
        ))
        .map_err(io::Error::other)?
        .ok_or_else(|| io::Error::other("Memory is in use"))?;
    let saved = save(root, paths, result);
    lease.release(saved.is_ok()).map_err(io::Error::other)?;
    saved
}

async fn acquire(
    root: &Path,
    paths: &CognitionPathEnvironment,
    coordinator: &Arc<CognitionWriteCoordinator>,
    token: &CancellationToken,
) -> io::Result<crate::coordination::CognitionWriteLease> {
    let request = CognitionWriteAcquire {
        lock_path: paths.consolidation_lock(root),
        purpose: Some("cutover".into()),
        deadline_at_epoch_ms: None,
        cancellation: Some(token.clone()),
    };
    let writer = coordinator.clone();
    let executor = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || {
        executor
            .block_on(writer.acquire(request, crate::coordination::CognitionWaitClass::Background))
    })
    .await
    .map_err(io::Error::other)?
    .map_err(io::Error::other)?
    .ok_or_else(|| io::Error::other("Memory is in use"))
}
