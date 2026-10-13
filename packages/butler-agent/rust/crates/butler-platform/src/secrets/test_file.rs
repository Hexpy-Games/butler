//! Test-support system-store substitute. Never opens Credential Manager.
use super::{Inner, SecretError, SecretKey, SecretStore, SecretText, file::FileSecrets};
use base64::{Engine, engine::general_purpose::STANDARD};
use std::path::Path;
use std::sync::Arc;
use windows_dpapi::{Scope, decrypt_data, encrypt_data};
use zeroize::Zeroizing;

pub(super) struct TestSecrets(FileSecrets);

pub(super) fn open(path: &Path) -> Result<SecretStore, SecretError> {
    let parent = path
        .parent()
        .ok_or_else(|| invalid_path())?
        .canonicalize()
        .map_err(SecretError::File)?;
    let temporary = std::env::temp_dir()
        .canonicalize()
        .map_err(SecretError::File)?;
    if parent == temporary || !parent.starts_with(temporary) {
        return Err(invalid_path());
    }
    Ok(SecretStore {
        // Exercise the system-store policies while replacing only persistence.
        backend: super::SYSTEM_BACKEND,
        inner: Inner::TestFile(Arc::new(TestSecrets(FileSecrets::new(path.into())))),
    })
}

fn invalid_path() -> SecretError {
    SecretError::File(std::io::Error::other(
        "test secret store requires a temporary directory",
    ))
}

impl TestSecrets {
    pub(super) fn get(&self, key: &SecretKey) -> Result<Option<SecretText>, SecretError> {
        self.0
            .get(key)?
            .map(|secret| {
                let blob = Zeroizing::new(
                    STANDARD
                        .decode(secret.expose())
                        .map_err(|_| SecretError::NotText)?,
                );
                let bytes =
                    Zeroizing::new(decrypt_data(&blob, Scope::User, None).map_err(|_| {
                        SecretError::File(std::io::Error::other("test secret decryption failed"))
                    })?);
                let text = std::str::from_utf8(&bytes).map_err(|_| SecretError::NotText)?;
                Ok(SecretText::new(text.into()))
            })
            .transpose()
    }

    pub(super) fn set(&self, key: &SecretKey, secret: &str) -> Result<(), SecretError> {
        let encrypted = Zeroizing::new(
            encrypt_data(secret.as_bytes(), Scope::User, None).map_err(|_| {
                SecretError::File(std::io::Error::other("test secret encryption failed"))
            })?,
        );
        self.0.set(key, &STANDARD.encode(&*encrypted))
    }

    pub(super) fn delete(&self, key: &SecretKey) -> Result<bool, SecretError> {
        self.0.delete(key)
    }
}
