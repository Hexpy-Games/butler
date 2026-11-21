//! Fresh mutation authority: a writer may change only the serving v2
//! generation or a building candidate.

use std::path::Path;

use super::manifest::{GenerationFormat, GenerationState, ProjectionMode};
use super::read::{error, read_descriptor, read_manifest};
use super::{MemoryGenerationHandle, MemoryGenerationTarget};
use crate::cognition::{CognitionCode, CognitionError, CognitionPathEnvironment};

/// Checks that `handle` is still the generation `target` may mutate.
pub fn assert_mutation_authority(
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
                && descriptor.projection_mode == Some(ProjectionMode::Running)
                && manifest.format == Some(GenerationFormat::V2)
        }
        MemoryGenerationTarget::Rebuild { .. } => {
            descriptor.generation_id != handle.generation_id
                && manifest.is_v2_in(GenerationState::Building)
        }
    };
    valid
        .then_some(())
        .ok_or_else(|| error(CognitionCode::MemoryGenerationChanged))
}
