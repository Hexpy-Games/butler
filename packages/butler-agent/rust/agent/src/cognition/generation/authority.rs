use std::path::Path;

use super::read::{error, read_descriptor, read_manifest};
use super::{MemoryGenerationHandle, MemoryGenerationTarget};
use crate::cognition::CognitionError;
use crate::cognition::CognitionPathEnvironment;

pub(crate) fn assert_mutation_authority(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    target: &MemoryGenerationTarget,
    handle: &MemoryGenerationHandle,
) -> Result<(), CognitionError> {
    let memory_root = environment.memory_root(data_root);
    let manifest = read_manifest(&memory_root, &handle.generation_id)?;
    let descriptor = read_descriptor(&memory_root)?;
    let valid = match target {
        MemoryGenerationTarget::Active { .. } => {
            descriptor.generation_id == handle.generation_id
                && descriptor.projection_mode.as_deref() == Some("running")
                && manifest.format == "v2"
        }
        MemoryGenerationTarget::Rebuild {
            canonical_snapshot_id,
            ..
        } => {
            descriptor.generation_id != handle.generation_id
                && manifest.format == "v2"
                && manifest.state.as_deref() == Some("building")
                && manifest.canonical_snapshot_id.as_deref() == Some(canonical_snapshot_id)
                && manifest.canonical_snapshot_path.is_some()
        }
    };
    valid
        .then_some(())
        .ok_or_else(|| error("memory_generation_changed"))
}
