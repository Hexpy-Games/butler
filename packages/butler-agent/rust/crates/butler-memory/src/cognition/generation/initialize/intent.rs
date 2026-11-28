//! Durable proof that bootstrap reserved a folder's first generation before producers.

use std::{fs, path::Path};

use serde::{Deserialize, Serialize};

use super::{durable, error};
use crate::cognition::{CognitionCode, CognitionPathEnvironment, CognitionResult};

const SCHEMA: &str = "butler.fresh-memory-initialization.v1";
const FILE: &str = "fresh-initialization.json";

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Intent {
    schema: String,
    pub(super) generation_id: String,
    pub(super) created_at: String,
}

fn read(root: &Path) -> CognitionResult<Option<Intent>> {
    let bytes = match fs::read(root.join(FILE)) {
        Ok(bytes) => bytes,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(source) => return Err(durable::io_error(source)),
    };
    let intent: Intent = serde_json::from_slice(&bytes)
        .map_err(|source| error(CognitionCode::MemoryInitializationIoError).with_source(source))?;
    if intent.schema != SCHEMA || uuid::Uuid::parse_str(&intent.generation_id).is_err() {
        return Err(error(CognitionCode::MemoryInitializationRequiresRebuild));
    }
    Ok(Some(intent))
}

/// Whether the folder still needs its first generation, or its descriptor
/// names the adopted pre-generation baseline.
pub(super) fn eligible(root: &Path, paths: &CognitionPathEnvironment) -> CognitionResult<bool> {
    let memory = paths.memory_root(root);
    let described = memory
        .join("active-generation.json")
        .try_exists()
        .map_err(durable::io_error)?;
    Ok(!described || names_baseline(&memory))
}

/// Whether the descriptor names the adopted pre-generation baseline, memory
/// under `db/` that no code reads any more. False when the descriptor or its
/// manifest cannot be read: that is an error for the resolver to report.
fn names_baseline(memory_root: &Path) -> bool {
    use super::super::{manifest::GenerationFormat, read as generation_read};
    generation_read::read_descriptor(memory_root)
        .and_then(|serving| generation_read::read_manifest(memory_root, &serving.generation_id))
        .is_ok_and(|manifest| manifest.format == Some(GenerationFormat::Legacy))
}

pub(super) fn reserve(data_root: &Path, memory_root: &Path, now: &str) -> CognitionResult<Intent> {
    if names_baseline(memory_root) {
        // The baseline's files stay in place; only the pointer goes.
        fs::remove_file(memory_root.join("active-generation.json")).map_err(durable::io_error)?;
        butler_platform::secure_fs::sync_path(memory_root).map_err(durable::io_error)?;
    }
    if let Some(intent) = read(memory_root)? {
        return Ok(intent);
    }
    let intent = Intent {
        schema: SCHEMA.into(),
        generation_id: uuid::Uuid::new_v4().to_string(),
        created_at: now.into(),
    };
    // A folder used before its first generation: what was said until now stays
    // out of memory. The exclusions are durable before the reservation exists.
    if butler_turn::conversation::conversation_store_path(data_root)
        .try_exists()
        .map_err(durable::io_error)?
    {
        super::exclude_earlier_conversations(data_root, memory_root, &intent.generation_id, now)?;
    }
    if let Err(failure) = durable::write_json(&memory_root.join(FILE), &intent) {
        // Nothing refers to the excluded generation's directory yet.
        let _ = butler_platform::secure_fs::remove_tree(
            &memory_root.join("generations").join(&intent.generation_id),
        );
        return Err(failure);
    }
    Ok(intent)
}

pub(super) fn finish(root: &Path) -> CognitionResult<()> {
    fs::remove_file(root.join(FILE)).map_err(durable::io_error)?;
    butler_platform::secure_fs::sync_path(root).map_err(durable::io_error)
}
