//! Private bearer keys for registered Custom model endpoints.

use std::{collections::HashMap, fs, io::Write, path::Path};

use butler_platform::secure_fs;
use serde_json::{Map, Value};

use crate::models::ModelCatalogError;

pub(super) async fn read(path: &Path) -> Result<HashMap<String, String>, ModelCatalogError> {
    let bytes = match tokio::fs::read(path).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(error) => return Err(read_failed(error)),
    };
    decode(&bytes)
}

pub(super) fn read_sync(path: &Path) -> Result<HashMap<String, String>, ModelCatalogError> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(error) => return Err(read_failed(error)),
    };
    decode(&bytes)
}

pub(super) fn write(
    path: &Path,
    credentials: &HashMap<String, String>,
) -> Result<(), ModelCatalogError> {
    let parent = path.parent().ok_or_else(write_error)?;
    fs::create_dir_all(parent).map_err(write_failed)?;

    let mut object = Map::new();
    for (model_ref, secret) in credentials {
        if !secret.is_empty() {
            object.insert(model_ref.clone(), Value::String(secret.clone()));
        }
    }
    let mut bytes = serde_json::to_vec(&Value::Object(object)).map_err(write_failed)?;
    bytes.push(b'\n');

    secure_fs::replace_private(
        path,
        |file| file.write_all(&bytes).map_err(write_failed),
        write_failed,
    )
}

fn decode(bytes: &[u8]) -> Result<HashMap<String, String>, ModelCatalogError> {
    let value: Value = serde_json::from_slice(bytes).map_err(read_failed)?;
    let object = value.as_object().ok_or_else(read_error)?;
    Ok(object
        .iter()
        .filter_map(|(key, value)| {
            value
                .as_str()
                .map(|secret| (key.clone(), secret.to_owned()))
        })
        .collect())
}

fn read_error() -> ModelCatalogError {
    ModelCatalogError::rejected("Custom model credentials could not be read.")
}

fn write_error() -> ModelCatalogError {
    ModelCatalogError::rejected("Custom model credentials could not be written.")
}

fn read_failed(source: impl Into<Box<dyn std::error::Error + Send + Sync>>) -> ModelCatalogError {
    ModelCatalogError::Storage {
        message: "Custom model credentials could not be read.",
        source: source.into(),
    }
}

fn write_failed(source: impl Into<Box<dyn std::error::Error + Send + Sync>>) -> ModelCatalogError {
    ModelCatalogError::Storage {
        message: "Custom model credentials could not be written.",
        source: source.into(),
    }
}
