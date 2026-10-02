//! Resolves which generation a caller may read: the serving generation named
//! by the descriptor, or a building rebuild candidate bound to its snapshot.

use std::path::{Path, PathBuf};

use super::manifest::{
    ACTIVE_DESCRIPTOR_SCHEMA, DescriptorView, EmbeddingSlot, GenerationFormat, GenerationManifest,
    GenerationState, ProjectionMode,
};
use super::types::{
    GenerationEmbedding, MemoryGenerationHandle, MemoryGenerationTarget,
    validate_generation_embedding,
};
use crate::cognition::paths::node_join;
use crate::cognition::{CognitionCode, CognitionError, CognitionPathEnvironment};

/// The serving generation as named by the descriptor.
pub(super) struct ServingGeneration {
    pub generation_id: String,
    pub projection_mode: Option<ProjectionMode>,
}

/// Whether a manifest read validates the bound embedding for runtime use.
#[derive(Clone, Copy, PartialEq, Eq)]
enum EmbeddingCheck {
    /// Resolve and validate the embedding the runtime will embed with.
    Runtime,
    /// Ignore the embedding; the caller only needs lifecycle facts.
    Skip,
}

/// The generation `target` names, checked to still be the one it names.
pub fn resolve_generation(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    target: &MemoryGenerationTarget,
) -> Result<MemoryGenerationHandle, CognitionError> {
    let memory_root = environment.memory_root(data_root);
    let active = matches!(target, MemoryGenerationTarget::Active { .. });
    let generation_id = match target {
        MemoryGenerationTarget::Active {
            expected_generation,
        } => {
            let descriptor = read_descriptor(&memory_root)?;
            if descriptor.generation_id != *expected_generation {
                return Err(error(CognitionCode::MemoryGenerationChanged));
            }
            descriptor.generation_id
        }
        MemoryGenerationTarget::Rebuild { generation_id, .. } => generation_id.clone(),
    };
    safe_generation_id(&generation_id)?;
    let manifest_root = memory_root.join("generations").join(&generation_id);
    let (manifest, embedding) = read_manifest_file(
        &manifest_root.join("manifest.json"),
        &generation_id,
        EmbeddingCheck::Runtime,
    )?;
    let Some(format) = manifest.format else {
        return Err(error(CognitionCode::MemoryGenerationVersionUnsupported));
    };
    let snapshot = manifest
        .canonical_snapshot_path
        .as_deref()
        .map(|path| node_join(&manifest_root, path));
    if let MemoryGenerationTarget::Rebuild {
        canonical_snapshot_id,
        ..
    } = target
        && (manifest.state != Some(GenerationState::Building)
            || format != GenerationFormat::V2
            || manifest.canonical_snapshot_id.as_deref() != Some(canonical_snapshot_id)
            || snapshot.is_none())
    {
        return Err(error(CognitionCode::MemorySnapshotChanged));
    }
    let root = match format {
        GenerationFormat::Legacy => memory_root.join("db"),
        GenerationFormat::V2 => manifest_root,
    };
    let source_root = if active {
        data_root.to_owned()
    } else {
        snapshot_source_root(snapshot.as_deref())?
    };
    let reader_pin = super::pins::pin(&root);
    if active && read_descriptor(&memory_root)?.generation_id != generation_id {
        return Err(error(CognitionCode::MemoryGenerationChanged));
    }
    Ok(MemoryGenerationHandle {
        reader_pin: Some(reader_pin),
        generation_id,
        graph_path: root.join("graph.sqlite"),
        root,
        embedding,
        source_root,
        canonical_snapshot_path: if active { None } else { snapshot },
    })
}

/// A rebuild reads sources from the snapshot root two levels above the
/// canonical store (`source-snapshot/runtime/conversation-store.sqlite`).
fn snapshot_source_root(snapshot: Option<&Path>) -> Result<PathBuf, CognitionError> {
    snapshot
        .and_then(Path::parent)
        .and_then(Path::parent)
        .map(Path::to_owned)
        .ok_or_else(|| error(CognitionCode::MemorySnapshotChanged))
}

/// The active memory generation.
pub fn resolve_active_generation(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
) -> Result<MemoryGenerationHandle, CognitionError> {
    let descriptor = read_descriptor(&environment.memory_root(data_root))?;
    resolve_generation(
        data_root,
        environment,
        &MemoryGenerationTarget::Active {
            expected_generation: descriptor.generation_id,
        },
    )
}

/// A projection candidate query may read its own building generation. This
/// does not grant mutation or serving authority to an inactive generation.
pub(crate) fn resolve_projection_generation(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    generation_id: &str,
) -> Result<MemoryGenerationHandle, CognitionError> {
    let memory_root = environment.memory_root(data_root);
    let active = read_descriptor(&memory_root)?;
    if active.generation_id == generation_id {
        return resolve_generation(
            data_root,
            environment,
            &MemoryGenerationTarget::Active {
                expected_generation: generation_id.to_owned(),
            },
        );
    }
    let manifest = read_manifest(&memory_root, generation_id)?;
    if manifest.state != Some(GenerationState::Building) {
        return Err(error(CognitionCode::MemoryGenerationChanged));
    }
    let snapshot_id = manifest
        .canonical_snapshot_id
        .ok_or_else(|| error(CognitionCode::MemorySnapshotChanged))?;
    resolve_generation(
        data_root,
        environment,
        &MemoryGenerationTarget::Rebuild {
            generation_id: generation_id.to_owned(),
            canonical_snapshot_id: snapshot_id,
        },
    )
}

/// Whether an active generation descriptor exists.
pub fn active_memory_descriptor_exists(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
) -> Result<bool, CognitionError> {
    environment
        .memory_root(data_root)
        .join("active-generation.json")
        .try_exists()
        .map_err(|error| {
            CognitionError::new(
                CognitionCode::MemoryGenerationUnavailable,
                error.to_string(),
            )
            .with_source(error)
        })
}

pub(super) fn read_descriptor(memory_root: &Path) -> Result<ServingGeneration, CognitionError> {
    let bytes = std::fs::read(memory_root.join("active-generation.json"))
        .map_err(|source| error(CognitionCode::MemoryGenerationUnavailable).with_source(source))?;
    let view: DescriptorView = serde_json::from_slice(&bytes)
        .map_err(|source| error(CognitionCode::MemoryGenerationUnavailable).with_source(source))?;
    let Some(generation_id) = view.generation_id.filter(|id| !id.is_empty()) else {
        return Err(error(CognitionCode::MemoryGenerationUnavailable));
    };
    if view.schema.as_deref() != Some(ACTIVE_DESCRIPTOR_SCHEMA) {
        return Err(error(CognitionCode::MemoryGenerationUnavailable));
    }
    Ok(ServingGeneration {
        generation_id,
        projection_mode: view.projection_mode,
    })
}

pub(super) fn read_manifest(
    memory_root: &Path,
    generation_id: &str,
) -> Result<GenerationManifest, CognitionError> {
    safe_generation_id(generation_id)?;
    read_manifest_file(
        &memory_root
            .join("generations")
            .join(generation_id)
            .join("manifest.json"),
        generation_id,
        EmbeddingCheck::Skip,
    )
    .map(|(manifest, _)| manifest)
}

fn read_manifest_file(
    path: &Path,
    generation_id: &str,
    check: EmbeddingCheck,
) -> Result<(GenerationManifest, Option<GenerationEmbedding>), CognitionError> {
    let manifest = GenerationManifest::read(path, CognitionCode::MemoryGenerationUnavailable)?;
    if !manifest.is_for(generation_id) {
        return Err(error(CognitionCode::MemoryGenerationVersionUnsupported));
    }
    let embedding = match (check, &manifest.embedding) {
        (EmbeddingCheck::Skip, _) | (EmbeddingCheck::Runtime, Some(EmbeddingSlot::Unbound)) => None,
        (EmbeddingCheck::Runtime, Some(EmbeddingSlot::Bound(embedding))) => {
            validate_generation_embedding(embedding)?;
            Some(GenerationEmbedding::clone(embedding))
        }
        (EmbeddingCheck::Runtime, Some(EmbeddingSlot::Unreadable(_)) | None) => {
            return Err(error(CognitionCode::MemoryEmbeddingMetadataInvalid));
        }
    };
    Ok((manifest, embedding))
}

pub(in crate::cognition::generation) fn safe_generation_id(
    value: &str,
) -> Result<(), CognitionError> {
    if value.len() == 36
        && value
            .bytes()
            .all(|byte| (byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()) || byte == b'-')
    {
        Ok(())
    } else {
        Err(error(CognitionCode::MemoryGenerationVersionUnsupported))
    }
}

pub(super) fn error(code: CognitionCode) -> CognitionError {
    CognitionError::new(code, code.as_str())
}
