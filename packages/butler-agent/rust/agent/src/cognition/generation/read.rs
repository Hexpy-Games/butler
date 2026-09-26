use std::path::Path;

use super::types::{
    ActiveDescriptor, GenerationEmbedding, GenerationManifest, MemoryGenerationHandle,
    MemoryGenerationTarget, validate_generation_embedding,
};
use crate::cognition::CognitionError;
use crate::cognition::CognitionPathEnvironment;
use crate::cognition::paths::node_join;
use serde_json::Value;

pub(crate) fn resolve_generation(
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
                return Err(error("memory_generation_changed"));
            }
            descriptor.generation_id
        }
        MemoryGenerationTarget::Rebuild { generation_id, .. } => generation_id.clone(),
    };
    safe_generation_id(&generation_id)?;
    let manifest_root = memory_root.join("generations").join(&generation_id);
    let manifest = read_manifest_file(&manifest_root.join("manifest.json"), &generation_id, true)?;
    if manifest.schema != "butler.memory-generation.v2"
        || !matches!(manifest.format.as_str(), "v2" | "legacy")
        || manifest.generation_id != generation_id
    {
        return Err(error("memory_generation_version_unsupported"));
    }
    if let Some(embedding) = &manifest.embedding {
        validate_generation_embedding(embedding)?;
    }
    let snapshot = manifest
        .canonical_snapshot_path
        .as_deref()
        .map(|path| node_join(&manifest_root, path));
    if let MemoryGenerationTarget::Rebuild {
        canonical_snapshot_id,
        ..
    } = target
        && (manifest.format != "v2"
            || manifest.canonical_snapshot_id.as_deref() != Some(canonical_snapshot_id)
            || snapshot.is_none())
    {
        return Err(error("memory_snapshot_changed"));
    }
    let root = if manifest.format == "legacy" {
        memory_root.join("db")
    } else {
        manifest_root
    };
    let source_root = if active {
        data_root.to_owned()
    } else {
        snapshot
            .as_deref()
            .and_then(Path::parent)
            .and_then(Path::parent)
            .ok_or_else(|| error("memory_snapshot_changed"))?
            .to_owned()
    };
    Ok(MemoryGenerationHandle {
        generation_id,
        graph_path: root.join("graph.sqlite"),
        root,
        embedding: manifest.embedding,
        source_root,
        canonical_snapshot_path: if active { None } else { snapshot },
    })
}

pub(crate) fn resolve_active_generation(
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
    if manifest.state.as_deref() != Some("building") {
        return Err(error("memory_generation_changed"));
    }
    let snapshot_id = manifest
        .canonical_snapshot_id
        .ok_or_else(|| error("memory_snapshot_changed"))?;
    resolve_generation(
        data_root,
        environment,
        &MemoryGenerationTarget::Rebuild {
            generation_id: generation_id.to_owned(),
            canonical_snapshot_id: snapshot_id,
        },
    )
}

pub(crate) fn active_memory_descriptor_exists(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
) -> Result<bool, CognitionError> {
    environment
        .memory_root(data_root)
        .join("active-generation.json")
        .try_exists()
        .map_err(|error| CognitionError::new("memory_generation_unavailable", error.to_string()))
}

pub(super) fn read_descriptor(memory_root: &Path) -> Result<ActiveDescriptor, CognitionError> {
    let value = read_json(&memory_root.join("active-generation.json"))?;
    let schema = string(&value, "schema");
    let generation_id = string(&value, "generation_id");
    if schema != Some("butler.memory-active-generation.v2")
        || generation_id.is_none_or(str::is_empty)
    {
        return Err(error("memory_generation_unavailable"));
    }
    Ok(ActiveDescriptor {
        generation_id: generation_id.unwrap().to_owned(),
        projection_mode: string(&value, "projection_mode").map(str::to_owned),
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
        false,
    )
}

fn read_json(path: &Path) -> Result<Value, CognitionError> {
    let bytes = std::fs::read(path).map_err(|_| error("memory_generation_unavailable"))?;
    serde_json::from_slice(&bytes).map_err(|_| error("memory_generation_unavailable"))
}

fn read_manifest_file(
    path: &Path,
    generation_id: &str,
    validate_runtime_embedding: bool,
) -> Result<GenerationManifest, CognitionError> {
    let value = read_json(path)?;
    let schema = string(&value, "schema").unwrap_or_default().to_owned();
    let stored_generation = string(&value, "generation_id")
        .unwrap_or_default()
        .to_owned();
    let format = string(&value, "format").unwrap_or_default().to_owned();
    if schema != "butler.memory-generation.v2" || stored_generation != generation_id {
        return Err(error("memory_generation_version_unsupported"));
    }
    let embedding_value = value.get("embedding");
    let embedding = if !validate_runtime_embedding || embedding_value.is_some_and(Value::is_null) {
        None
    } else {
        let embedding_value =
            embedding_value.ok_or_else(|| error("memory_embedding_metadata_invalid"))?;
        let object = embedding_value
            .as_object()
            .ok_or_else(|| error("memory_embedding_metadata_invalid"))?;
        if !object.contains_key("bun_runtime_version")
            && string(embedding_value, "schema") != Some("butler.native-embedding-identity.v1")
        {
            return Err(error("memory_embedding_metadata_invalid"));
        }
        let embedding: GenerationEmbedding = serde_json::from_value(embedding_value.clone())
            .map_err(|_| error("memory_embedding_metadata_invalid"))?;
        validate_generation_embedding(&embedding)?;
        Some(embedding)
    };
    Ok(GenerationManifest {
        schema,
        generation_id: stored_generation,
        format,
        state: string(&value, "state").map(str::to_owned),
        embedding,
        canonical_snapshot_id: string(&value, "canonical_snapshot_id").map(str::to_owned),
        canonical_snapshot_path: string(&value, "canonical_snapshot_path").map(str::to_owned),
    })
}

fn string<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
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
        Err(error("memory_generation_version_unsupported"))
    }
}

pub(super) fn error(code: &'static str) -> CognitionError {
    CognitionError::new(code, code)
}
