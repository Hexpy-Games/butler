//! Durable proof that bootstrap reserved a truly fresh root before producers.

use std::{fs, path::Path};

use serde::{Deserialize, Serialize};

use super::{durable, empty, error};
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

pub(super) fn eligible(root: &Path, paths: &CognitionPathEnvironment) -> CognitionResult<bool> {
    let memory = paths.memory_root(root);
    if memory
        .join("active-generation.json")
        .try_exists()
        .map_err(durable::io_error)?
    {
        return Ok(false);
    }
    if read(&memory)?.is_some() {
        return Ok(true);
    }
    // Existing sources have no fresh reservation and remain rebuild-only.
    if butler_turn::conversation::conversation_store_path(root).exists()
        || empty::has_entries(&memory)?
        || empty::has_entries(&root.join("tasks"))?
        || empty::has_entries(&paths.cognition_root(root).join("box"))?
        || empty::has_entries(&paths.cognition_root(root).join("rules"))?
    {
        return Ok(false);
    }
    match fs::metadata(paths.cognition_root(root).join("feedback/feedback.md")) {
        Ok(metadata) => Ok(metadata.len() == 0),
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(source) => Err(durable::io_error(source)),
    }
}

pub(super) fn reserve(root: &Path, now: &str) -> CognitionResult<Intent> {
    if let Some(intent) = read(root)? {
        return Ok(intent);
    }
    let intent = Intent {
        schema: SCHEMA.into(),
        generation_id: uuid::Uuid::new_v4().to_string(),
        created_at: now.into(),
    };
    durable::write_json(&root.join(FILE), &intent)?;
    Ok(intent)
}

pub(super) fn finish(root: &Path) -> CognitionResult<()> {
    fs::remove_file(root.join(FILE)).map_err(durable::io_error)?;
    butler_platform::secure_fs::sync_path(root).map_err(durable::io_error)
}
