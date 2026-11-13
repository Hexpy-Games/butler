//! Private bearer keys for registered Custom model endpoints.

use std::{collections::HashMap, fs, io::Write, path::Path, sync::Arc};

use butler_platform::{secrets::SecretText, secure_fs};
use butler_vault::vault::{ItemKind, ProductVault, shared};
use serde_json::{Map, Value};

use crate::models::ModelCatalogError;

pub(super) const FILE: &str = "auth/custom-model-credentials.json";
const VAULT_PREFIX: &str = "custom_model/";

pub(super) async fn read(root: &Path) -> Result<HashMap<String, String>, ModelCatalogError> {
    let root = root.to_path_buf();
    tokio::task::spawn_blocking(move || read_sync(&root))
        .await
        .map_err(read_failed)?
}

fn vault(root: &Path) -> Result<Option<Arc<ProductVault>>, ModelCatalogError> {
    let vault = shared(root);
    if !vault.unattended() {
        return Ok(None);
    }
    match vault.active() {
        Ok(true) => Ok(Some(vault)),
        Ok(false) => Ok(None),
        Err(error) => Err(read_failed(error)),
    }
}

pub(super) fn read_sync(root: &Path) -> Result<HashMap<String, String>, ModelCatalogError> {
    let Some(vault) = vault(root)? else {
        return read_file(root);
    };
    Ok(vault
        .items_with_prefix(VAULT_PREFIX)
        .map_err(read_failed)?
        .into_iter()
        .map(|(id, secret)| {
            let model_ref = id[VAULT_PREFIX.len()..].to_owned();
            butler_log::register_secret_for(&format!("local:{model_ref}"), secret.expose());
            (model_ref, secret.expose().to_owned())
        })
        .collect())
}

pub(super) fn read_file(root: &Path) -> Result<HashMap<String, String>, ModelCatalogError> {
    let path = &root.join(FILE);
    protect_existing(path)?;
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(error) => return Err(read_failed(error)),
    };
    decode(&bytes)
}

pub(super) fn write(
    root: &Path,
    credentials: &HashMap<String, String>,
) -> Result<(), ModelCatalogError> {
    for (source, secret) in credentials {
        butler_log::register_secret_for(&format!("local:{source}"), secret);
    }
    if let Some(vault) = vault(root).map_err(write_failed)? {
        let current = vault
            .items_with_prefix(VAULT_PREFIX)
            .map_err(write_failed)?;
        for (model_ref, secret) in credentials {
            let id = format!("{VAULT_PREFIX}{model_ref}");
            if !secret.is_empty()
                && !current
                    .iter()
                    .any(|(current_id, value)| current_id == &id && value.expose() == secret)
            {
                vault
                    .put(&id, ItemKind::ApiKey, SecretText::new(secret.clone()))
                    .map_err(write_failed)?;
            }
        }
        for (id, _) in current {
            if credentials
                .get(&id[VAULT_PREFIX.len()..])
                .is_none_or(String::is_empty)
            {
                vault.delete(&id).map_err(write_failed)?;
            }
        }
        return Ok(());
    }
    let path = &root.join(FILE);
    let parent = path.parent().ok_or_else(write_error)?;
    if secure_fs::OWNER_ONLY {
        fs::create_dir_all(parent).map_err(write_failed)?;
    } else {
        secure_fs::create_private_dir_all(parent).map_err(write_failed)?;
        secure_fs::protect_folder(parent)
            .transpose()
            .map_err(write_failed)?;
    }

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

fn protect_existing(path: &Path) -> Result<(), ModelCatalogError> {
    if !secure_fs::OWNER_ONLY && path.exists() {
        secure_fs::restrict_file(path)
            .transpose()
            .map_err(read_failed)?;
    }
    Ok(())
}

fn decode(bytes: &[u8]) -> Result<HashMap<String, String>, ModelCatalogError> {
    let value: Value = serde_json::from_slice(bytes).map_err(read_failed)?;
    let object = value.as_object().ok_or_else(read_error)?;
    Ok(object
        .iter()
        .filter_map(|(key, value)| {
            value.as_str().map(|secret| {
                butler_log::register_secret_for(&format!("local:{key}"), secret);
                (key.clone(), secret.to_owned())
            })
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
