//! Enumerate system-store identifiers using the credential owner's exact key rule.
use super::{
    credentials::{CREDENTIALS_FILE, CredentialsFile},
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
    ids.into_iter()
        .map(|(provider, id, backend)| {
            let key = secret_store::key(root, backend, &provider, &id).map_err(io::Error::other)?;
            Ok((key.service().to_owned(), key.account().to_owned()))
        })
        .collect()
}
