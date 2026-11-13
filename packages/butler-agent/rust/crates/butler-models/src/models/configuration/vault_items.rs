//! Legacy API keys copied when this data folder switches to the vault.
use super::{
    credentials::{CREDENTIALS_FILE, CredentialsFile},
    local_credentials, secret_store,
};
use butler_platform::secrets::{SecretBackend, SecretText};
use butler_vault::vault::{ItemKind, LegacyItem, LegacySource};
use std::{collections::HashSet, io, path::Path};

pub fn vault_legacy_items(root: &Path) -> io::Result<Vec<LegacyItem>> {
    let file = CredentialsFile::load(&root.join(CREDENTIALS_FILE)).map_err(io::Error::other)?;
    let mut seen = HashSet::new();
    let mut items = Vec::new();
    for entry in file.entries() {
        if entry.get("auth_type").and_then(serde_json::Value::as_str) != Some("api_key") {
            continue;
        }
        let (Some(provider), Some(id)) = (
            entry.get("provider_id").and_then(serde_json::Value::as_str),
            entry.get("id").and_then(serde_json::Value::as_str),
        ) else {
            continue;
        };
        if !seen.insert((provider, id)) {
            continue;
        }
        let mut sources = Vec::new();
        if let Some(secret) = entry.get("secret").and_then(serde_json::Value::as_str) {
            sources.push(LegacySource::Value(SecretText::new(secret.to_owned())));
        } else if let Some(backend) = entry
            .get("storage")
            .and_then(serde_json::Value::as_str)
            .and_then(SecretBackend::from_name)
        {
            let key = secret_store::key(root, backend, provider, id).map_err(io::Error::other)?;
            if backend.is_system() {
                sources.push(LegacySource::System(key));
            } else if let Some(value) = secret_store::fallback_file(root)
                .get(&key)
                .map_err(io::Error::other)?
            {
                sources.push(LegacySource::Value(value));
            }
        }
        items.push(LegacyItem {
            id: secret_store::vault_id(provider, id),
            kind: ItemKind::ApiKey,
            sources,
        });
    }
    for (model_ref, secret) in local_credentials::read_file(root).map_err(io::Error::other)? {
        if !secret.is_empty() {
            items.push(LegacyItem {
                id: format!("custom_model/{model_ref}"),
                kind: ItemKind::ApiKey,
                sources: vec![LegacySource::Value(SecretText::new(secret))],
            });
        }
    }
    Ok(items)
}
