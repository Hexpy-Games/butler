//! Fresh mutation authority: a writer may change only the serving v2
//! generation or the building candidate bound to its snapshot.

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
            let logical_root = memory_root
                .join("generations")
                .join(&descriptor.generation_id);
            let graph = super::read::physical_graph(
                &memory_root,
                &logical_root,
                descriptor.storage_generation_id.as_deref(),
            )?;
            descriptor.generation_id == handle.generation_id
                && handle.root == logical_root
                && handle.graph_path == graph
                && descriptor.projection_mode == Some(ProjectionMode::Running)
                && manifest.format == Some(GenerationFormat::V2)
        }
        MemoryGenerationTarget::Rebuild {
            canonical_snapshot_id,
            ..
        } => {
            descriptor.generation_id != handle.generation_id
                && manifest.is_v2_in(GenerationState::Building)
                && manifest.canonical_snapshot_id.as_deref() == Some(canonical_snapshot_id)
                && manifest.canonical_snapshot_path.is_some()
        }
    };
    valid
        .then_some(())
        .ok_or_else(|| error(CognitionCode::MemoryGenerationChanged))
}
