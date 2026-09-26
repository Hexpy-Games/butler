//! Source-bound memory generation cutover. The descriptor is the serving authority.

mod activate;
mod descriptor;
mod qualification;
mod rollback;

use std::{fs, path::Path, sync::Arc};

use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use crate::{
    cognition::{CognitionError, CognitionPathEnvironment, CognitionResult, ensure_data_authority},
    coordination::{CognitionWaitClass, CognitionWriteAcquire, CognitionWriteCoordinator},
};

pub(crate) use activate::activate;
pub(crate) use rollback::rollback;

pub(crate) async fn repair_pending(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    cancellation: &CancellationToken,
) -> CognitionResult<()> {
    let memory_root = environment.memory_root(data_root);
    let descriptor_path = memory_root.join("active-generation.json");
    let lock = environment.consolidation_lock(data_root);
    ensure_data_authority(data_root, &[&memory_root, &descriptor_path, &lock])?;
    let capture = descriptor::capture_active_descriptor(data_root, environment)?;
    let Some(previous_id) = capture.fields.previous_generation_id.as_deref() else {
        return Ok(());
    };
    let target_path = manifest_path(data_root, environment, &capture.fields.generation_id)?;
    let previous_path = manifest_path(data_root, environment, previous_id)?;
    let (target_manifest, _) = read_manifest(&target_path, &capture.fields.generation_id)?;
    let (previous_manifest, _) = read_manifest(&previous_path, previous_id)?;
    // A previous target may be rebuilding or freshly requalified while the
    // descriptor still points at the current active generation. Only a
    // confirmed descriptor target awaiting its state write needs repair.
    if target_manifest["state"] == "active"
        && matches!(
            previous_manifest["state"].as_str(),
            Some("retired" | "building" | "ready")
        )
    {
        return Ok(());
    }
    if target_manifest["state"] != "active" && previous_manifest["state"] != "active" {
        return Err(error("memory_generation_changed"));
    }
    let lease = coordinator
        .acquire(
            CognitionWriteAcquire {
                lock_path: lock,
                purpose: Some("cutover".into()),
                deadline_at_epoch_ms: None,
                cancellation: Some(cancellation.clone()),
            },
            CognitionWaitClass::Background,
        )
        .await
        .map_err(|_| error("memory_write_busy"))?
        .ok_or_else(|| error("memory_write_busy"))?;
    let result = if cancellation.is_cancelled() {
        Err(error("memory_operation_aborted"))
    } else {
        descriptor::reconcile_committed_manifest_states(
            data_root,
            environment,
            &lease,
            &capture.raw,
        )
    };
    let released = lease
        .release(result.is_ok())
        .map_err(|_| error("memory_write_busy"));
    result?;
    released
}

fn manifest_path(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    generation_id: &str,
) -> CognitionResult<std::path::PathBuf> {
    super::read::safe_generation_id(generation_id)?;
    let path = environment
        .memory_root(data_root)
        .join("generations")
        .join(generation_id)
        .join("manifest.json");
    ensure_data_authority(data_root, &[&path])?;
    Ok(path)
}

fn read_manifest(path: &Path, generation_id: &str) -> CognitionResult<(Value, String)> {
    let bytes = fs::read(path).map_err(|_| error("memory_generation_unavailable"))?;
    let manifest: Value =
        serde_json::from_slice(&bytes).map_err(|_| error("memory_generation_unavailable"))?;
    if manifest["schema"] != "butler.memory-generation.v2"
        || manifest["generation_id"] != generation_id
    {
        return Err(error("memory_generation_version_unsupported"));
    }
    Ok((manifest, format!("{:x}", Sha256::digest(bytes))))
}

fn field<'a>(value: &'a Value, key: &str) -> CognitionResult<&'a str> {
    value[key]
        .as_str()
        .ok_or_else(|| error("memory_generation_changed"))
}

fn error(code: &'static str) -> CognitionError {
    CognitionError::new(code, code)
}
