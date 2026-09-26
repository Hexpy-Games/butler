//! Private bearer keys for registered Custom model endpoints.

use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
};

use serde_json::{Map, Value};

use crate::models::ModelCatalogError;

pub(super) async fn read(path: &Path) -> Result<HashMap<String, String>, ModelCatalogError> {
    let bytes = match tokio::fs::read(path).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(_) => return Err(read_error()),
    };
    decode(&bytes)
}

pub(super) fn read_sync(path: &Path) -> Result<HashMap<String, String>, ModelCatalogError> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(_) => return Err(read_error()),
    };
    decode(&bytes)
}

pub(super) fn write(
    path: &Path,
    credentials: &HashMap<String, String>,
) -> Result<(), ModelCatalogError> {
    let parent = path.parent().ok_or_else(write_error)?;
    fs::create_dir_all(parent).map_err(|_| write_error())?;

    let mut object = Map::new();
    for (model_ref, secret) in credentials {
        if !secret.is_empty() {
            object.insert(model_ref.clone(), Value::String(secret.clone()));
        }
    }
    let mut bytes = serde_json::to_vec(&Value::Object(object)).map_err(|_| write_error())?;
    bytes.push(b'\n');

    let temp = parent.join(format!(
        "custom-model-credentials.json.{}.tmp",
        uuid::Uuid::new_v4()
    ));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temp).map_err(|_| write_error())?;
    if file.write_all(&bytes).is_err() || file.sync_all().is_err() {
        drop(file);
        let _ = fs::remove_file(&temp);
        return Err(write_error());
    }
    drop(file);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if fs::set_permissions(&temp, fs::Permissions::from_mode(0o600)).is_err() {
            let _ = fs::remove_file(&temp);
            return Err(write_error());
        }
    }
    if fs::rename(&temp, path).is_err() {
        let _ = fs::remove_file(&temp);
        return Err(write_error());
    }
    Ok(())
}

fn decode(bytes: &[u8]) -> Result<HashMap<String, String>, ModelCatalogError> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| read_error())?;
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
    ModelCatalogError::new("Custom model credentials could not be read.")
}

fn write_error() -> ModelCatalogError {
    ModelCatalogError::new("Custom model credentials could not be written.")
}
