//! Source-bound memory generation cutover. The descriptor is the serving authority.

mod activate;
mod descriptor;
mod qualification;
mod rollback;

use crate::cognition::CognitionCode;
use std::{fs, path::Path, sync::Arc};

use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use crate::{
    cognition::{CognitionError, CognitionPathEnvironment, CognitionResult, ensure_data_authority},
    coordination::CognitionWriteCoordinator,
};

pub use activate::activate;
pub use rollback::{RollbackOutcome, RollbackStep};

use super::manifest::{GenerationManifest, GenerationState};

/// When a cutover happens and which implementation commit its qualification
/// must name (`None` for builds that cannot claim one).
#[derive(Clone, Copy)]
pub struct CutoverStamp<'a> {
    pub now: &'a str,
    pub verified_commit: Option<&'a str>,
}
#[cfg(test)]
pub(super) use descriptor::next_descriptor as next_descriptor_for_pin;
pub use rollback::rollback;

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
    let active = Some(GenerationState::Active);
    if target_manifest.state == active
        && matches!(
            previous_manifest.state,
            Some(GenerationState::Retired | GenerationState::Building | GenerationState::Ready)
        )
    {
        return Ok(());
    }
    if target_manifest.state != active && previous_manifest.state != active {
        return Err(error(CognitionCode::MemoryGenerationChanged));
    }
    let lease =
        crate::cognition::generation::stage::acquire(&coordinator, &lock, "cutover", cancellation)
            .await?;
    let result = if cancellation.is_cancelled() {
        Err(error(CognitionCode::MemoryOperationAborted))
    } else {
        descriptor::reconcile_committed_manifest_states(data_root, environment, &lease, &capture)
    };
    let released = lease
        .release(result.is_ok())
        .map_err(|source| error(CognitionCode::MemoryWriteBusy).with_source(source));
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

/// Reads a manifest with the SHA-256 of the exact bytes read.
fn read_manifest(
    path: &Path,
    generation_id: &str,
) -> CognitionResult<(GenerationManifest, String)> {
    let bytes = fs::read(path)
        .map_err(|source| error(CognitionCode::MemoryGenerationUnavailable).with_source(source))?;
    let manifest = GenerationManifest::parse(&bytes, CognitionCode::MemoryGenerationUnavailable)?;
    if !manifest.is_for(generation_id) {
        return Err(error(CognitionCode::MemoryGenerationVersionUnsupported));
    }
    Ok((manifest, format!("{:x}", Sha256::digest(bytes))))
}

/// A string fact the cutover requires.
fn required(value: Option<&str>) -> CognitionResult<&str> {
    value.ok_or_else(|| error(CognitionCode::MemoryGenerationChanged))
}

fn error(code: CognitionCode) -> CognitionError {
    CognitionError::new(code, code.as_str())
}
