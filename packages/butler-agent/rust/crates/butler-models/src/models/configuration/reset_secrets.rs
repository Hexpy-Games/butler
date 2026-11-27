//! Enumerate system-store identifiers using the credential owner's exact key rule.
use super::{
    credentials::{CREDENTIALS_FILE, CredentialsFile},
    mcp_secrets::{mcp_store_key, stored_secret_refs},
    secret_store,
};
use butler_platform::secrets::SecretBackend;
use std::{io, path::Path};
pub fn reset_secret_keys(root: &Path) -> io::Result<Vec<(String, String)>> {
    let file = CredentialsFile::load(&root.join(CREDENTIALS_FILE)).map_err(io::Error::other)?;
    let mut ids = file
        .entries()
        .iter()
        .filter_map(|entry| {
            let backend = entry.get("storage").and_then(serde_json::Value::as_str)?;
            let backend = SecretBackend::from_name(backend)?;
            if !backend.is_system() {
                return None;
            }
            Some((
                entry.get("provider_id")?.as_str()?.to_owned(),
                entry.get("id")?.as_str()?.to_owned(),
                backend,
            ))
        })
        .collect::<Vec<_>>();
    ids.extend(
        file.pending_removals()
            .into_iter()
            .filter(|p| p.backend.is_system())
            .map(|p| (p.provider_id, p.id, p.backend)),
    );
    for (id, home) in super::computer_keys::homes(root)? {
        if let Some(backend) = SecretBackend::from_name(&home).filter(|backend| backend.is_system())
        {
            ids.push(("computer_env".into(), id.clone(), backend));
            ids.push(("computer_key".into(), id, backend));
        }
    }
    if let Some((provider, id, backend)) = super::device_ssh_key::system_key(root)? {
        ids.push((provider.into(), id.into(), backend));
    }
    let mut keys = ids
        .into_iter()
        .map(|(provider, id, backend)| {
            let key = secret_store::key(root, backend, &provider, &id).map_err(io::Error::other)?;
            Ok((key.service().to_owned(), key.account().to_owned()))
        })
        .collect::<io::Result<Vec<_>>>()?;
    for (id, backend) in stored_secret_refs(root).map_err(io::Error::other)? {
        if backend.is_system() {
            let key = mcp_store_key(root, backend, &id).map_err(io::Error::other)?;
            keys.push((key.service().to_owned(), key.account().to_owned()));
        }
    }
    Ok(keys)
}
