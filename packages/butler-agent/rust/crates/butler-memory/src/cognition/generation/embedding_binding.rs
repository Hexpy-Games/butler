//! Binds the observed native embedding identity to a generation that has none.

use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
};

use super::{
    MemoryGenerationHandle, MemoryGenerationTarget,
    authority::assert_mutation_authority,
    manifest::{
        EmbeddingSlot, GenerationFormat, GenerationManifest, GenerationState, InitializationOrigin,
    },
    read::{error, resolve_generation},
    types::{GenerationEmbedding, validate_native_embedding_identity},
};
use crate::cognition::CognitionCode;
use crate::{
    cognition::{
        CognitionError, CognitionPathEnvironment, embedding::EmbeddingIdentity,
        ensure_data_authority,
    },
    coordination::CognitionWriteLease,
};

/// Binds a native embedding identity to a generation that has none yet.
pub fn bind_native_embedding_identity(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    target: &MemoryGenerationTarget,
    handle: &MemoryGenerationHandle,
    observed: &EmbeddingIdentity,
    lease: &CognitionWriteLease,
) -> Result<GenerationEmbedding, CognitionError> {
    let lock_path = environment.consolidation_lock(data_root);
    lease
        .assert_for_path(&lock_path)
        .map_err(CognitionError::from)?;
    validate_native_embedding_identity(observed)?;

    let current = resolve_generation(data_root, environment, target)?;
    if current != *handle || current.embedding.is_some() {
        return Err(error(CognitionCode::MemoryGenerationChanged));
    }
    assert_mutation_authority(data_root, environment, target, &current)?;

    let manifest_path = current.root.join("manifest.json");
    assert_write_authority(data_root, environment, &current, &manifest_path, &lock_path)?;
    let mut manifest =
        GenerationManifest::read(&manifest_path, CognitionCode::MemoryGenerationUnavailable)?;
    if !is_eligible_empty_target(&manifest, target, &current.generation_id) {
        return Err(error(CognitionCode::MemoryGenerationChanged));
    }

    let embedding = GenerationEmbedding::Native(observed.clone());
    manifest.embedding = Some(EmbeddingSlot::Bound(Box::new(embedding.clone())));
    write_manifest_atomically(
        data_root,
        environment,
        &current,
        &manifest_path,
        &lock_path,
        lease,
        &manifest,
    )?;
    Ok(embedding)
}

/// Only a v2 generation that has never had an embedding may be bound: the
/// empty-root active generation or a rebuild candidate on its snapshot.
fn is_eligible_empty_target(
    manifest: &GenerationManifest,
    target: &MemoryGenerationTarget,
    generation_id: &str,
) -> bool {
    if !manifest.is_for(generation_id)
        || manifest.format != Some(GenerationFormat::V2)
        || !manifest.embedding_unbound()
    {
        return false;
    }
    match target {
        MemoryGenerationTarget::Active {
            expected_generation,
        } => {
            expected_generation == generation_id
                && manifest.state == Some(GenerationState::Active)
                && manifest.initialization_origin == Some(InitializationOrigin::Empty)
        }
        MemoryGenerationTarget::Rebuild {
            generation_id: target_generation,
            canonical_snapshot_id,
        } => {
            target_generation == generation_id
                && manifest.state == Some(GenerationState::Building)
                && manifest.initialization_origin == Some(InitializationOrigin::Rebuild)
                && manifest.canonical_snapshot_id.as_deref() == Some(canonical_snapshot_id)
                && manifest
                    .canonical_snapshot_path
                    .as_deref()
                    .is_some_and(|path| !path.is_empty())
        }
    }
}

fn assert_write_authority(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    handle: &MemoryGenerationHandle,
    manifest_path: &Path,
    lock_path: &Path,
) -> Result<(), CognitionError> {
    ensure_data_authority(
        data_root,
        &[
            &environment.memory_root(data_root),
            &handle.root,
            manifest_path,
            lock_path,
        ],
    )
}

fn write_manifest_atomically(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    handle: &MemoryGenerationHandle,
    manifest_path: &Path,
    lock_path: &Path,
    lease: &CognitionWriteLease,
    manifest: &GenerationManifest,
) -> Result<(), CognitionError> {
    let text = serde_json::to_string(manifest).map_err(|source| {
        error(CognitionCode::MemoryEmbeddingMetadataInvalid).with_source(source)
    })?;
    let parent = manifest_path
        .parent()
        .ok_or_else(|| error(CognitionCode::MemoryGenerationUnavailable))?;
    let temporary = manifest_path.with_extension(format!(
        "{}.{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    assert_write_authority(data_root, environment, handle, manifest_path, lock_path)?;
    lease
        .assert_for_path(lock_path)
        .map_err(CognitionError::from)?;

    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        butler_platform::secure_fs::owner_only(&mut options);
        let mut file = options.open(&temporary).map_err(write_error)?;
        file.write_all(text.as_bytes()).map_err(write_error)?;
        file.write_all(b"\n").map_err(write_error)?;
        file.sync_all().map_err(write_error)?;
        drop(file);

        assert_write_authority(data_root, environment, handle, manifest_path, lock_path)?;
        lease
            .assert_for_path(lock_path)
            .map_err(CognitionError::from)?;
        fs::rename(&temporary, manifest_path).map_err(write_error)?;
        butler_platform::secure_fs::sync_path(parent).map_err(write_error)
    })();
    let _ = fs::remove_file(&temporary);
    result
}

fn write_error(error: std::io::Error) -> CognitionError {
    CognitionError::new(
        CognitionCode::MemoryInitializationIoError,
        error.to_string(),
    )
    .with_source(error)
}
