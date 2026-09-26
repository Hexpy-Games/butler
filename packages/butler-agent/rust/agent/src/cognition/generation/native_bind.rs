use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::Path,
};

use serde_json::Value;

use super::{
    MemoryGenerationHandle, MemoryGenerationTarget,
    authority::assert_mutation_authority,
    read::{error, resolve_generation},
    types::{GenerationEmbedding, validate_native_embedding_identity},
};
use crate::{
    cognition::{
        CognitionError, CognitionPathEnvironment, embedding::NativeEmbeddingIdentity,
        ensure_data_authority,
    },
    coordination::CognitionWriteLease,
};

pub(crate) fn bind_native_embedding_identity(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    target: &MemoryGenerationTarget,
    handle: &MemoryGenerationHandle,
    observed: &NativeEmbeddingIdentity,
    lease: &CognitionWriteLease,
) -> Result<GenerationEmbedding, CognitionError> {
    let lock_path = environment.consolidation_lock(data_root);
    lease
        .assert_for_path(&lock_path)
        .map_err(|failure| CognitionError::new(failure.code, failure.message))?;
    validate_native_embedding_identity(observed)?;

    let current = resolve_generation(data_root, environment, target)?;
    if current != *handle || current.embedding.is_some() {
        return Err(error("memory_generation_changed"));
    }
    assert_mutation_authority(data_root, environment, target, &current)?;

    let manifest_path = current.root.join("manifest.json");
    assert_write_authority(data_root, environment, &current, &manifest_path, &lock_path)?;
    let mut manifest = read_manifest_value(&manifest_path)?;
    if !is_eligible_empty_target(&manifest, target, &current.generation_id) {
        return Err(error("memory_generation_changed"));
    }

    let embedding = GenerationEmbedding::Native(observed.clone());
    manifest["embedding"] =
        serde_json::to_value(&embedding).map_err(|_| error("memory_embedding_metadata_invalid"))?;
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

fn is_eligible_empty_target(
    manifest: &Value,
    target: &MemoryGenerationTarget,
    generation_id: &str,
) -> bool {
    let is_null_embedding = manifest.get("embedding").is_some_and(Value::is_null);
    let common = manifest.get("schema").and_then(Value::as_str)
        == Some("butler.memory-generation.v2")
        && manifest.get("format").and_then(Value::as_str) == Some("v2")
        && manifest.get("generation_id").and_then(Value::as_str) == Some(generation_id)
        && is_null_embedding;
    if !common {
        return false;
    }

    match target {
        MemoryGenerationTarget::Active {
            expected_generation,
        } => {
            expected_generation == generation_id
                && manifest.get("state").and_then(Value::as_str) == Some("active")
                && manifest
                    .get("initialization_origin")
                    .and_then(Value::as_str)
                    == Some("empty")
        }
        MemoryGenerationTarget::Rebuild {
            generation_id: target_generation,
            canonical_snapshot_id,
        } => {
            target_generation == generation_id
                && manifest.get("state").and_then(Value::as_str) == Some("building")
                && manifest
                    .get("initialization_origin")
                    .and_then(Value::as_str)
                    == Some("rebuild")
                && manifest
                    .get("canonical_snapshot_id")
                    .and_then(Value::as_str)
                    == Some(canonical_snapshot_id)
                && manifest
                    .get("canonical_snapshot_path")
                    .and_then(Value::as_str)
                    .is_some_and(|path| !path.is_empty())
        }
    }
}

fn read_manifest_value(path: &Path) -> Result<Value, CognitionError> {
    let bytes = fs::read(path).map_err(|_| error("memory_generation_unavailable"))?;
    serde_json::from_slice(&bytes).map_err(|_| error("memory_generation_unavailable"))
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
    manifest: &Value,
) -> Result<(), CognitionError> {
    let parent = manifest_path
        .parent()
        .ok_or_else(|| error("memory_generation_unavailable"))?;
    let temporary = manifest_path.with_extension(format!(
        "{}.{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    assert_write_authority(data_root, environment, handle, manifest_path, lock_path)?;
    lease
        .assert_for_path(lock_path)
        .map_err(|failure| CognitionError::new(failure.code, failure.message))?;

    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(write_error)?;
        file.write_all(manifest.to_string().as_bytes())
            .map_err(write_error)?;
        file.write_all(b"\n").map_err(write_error)?;
        file.sync_all().map_err(write_error)?;
        drop(file);

        assert_write_authority(data_root, environment, handle, manifest_path, lock_path)?;
        lease
            .assert_for_path(lock_path)
            .map_err(|failure| CognitionError::new(failure.code, failure.message))?;
        fs::rename(&temporary, manifest_path).map_err(write_error)?;
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(write_error)
    })();
    let _ = fs::remove_file(&temporary);
    result
}

#[expect(
    clippy::needless_pass_by_value,
    reason = "map_err/iterator adapter taking owned values"
)]
fn write_error(error: std::io::Error) -> CognitionError {
    CognitionError::new("memory_initialization_io_error", error.to_string())
}
