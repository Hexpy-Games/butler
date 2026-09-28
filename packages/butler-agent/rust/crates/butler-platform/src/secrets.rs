//! Secrets in the operating system's credential store (#217): the macOS
//! Keychain, the Secret Service on Linux (over D-Bus), the Windows Credential
//! Manager. Where the system store cannot be used (no D-Bus session or no
//! Secret Service on a headless Linux, or `BUTLER_SECRET_STORE=file`), an
//! owner-only file in the data folder holds the secrets instead
//! ([`SecretBackend::FallbackFile`]); callers report that backend by name.
//!
//! A secret is addressed by a [`SecretKey`]: a service (`Butler`) and an
//! account that names what the secret is for. Every operation is blocking;
//! async callers run it on a blocking thread. Secrets come back as
//! [`SecretText`], which is wiped from memory when dropped and never prints.

use std::fmt;
use std::path::PathBuf;
use std::sync::Arc;

use zeroize::Zeroizing;

mod file;
#[cfg(target_os = "macos")]
mod keychain;
#[cfg(target_os = "macos")]
use keychain as sys;
#[cfg(all(unix, not(target_os = "macos")))]
mod secret_service;
#[cfg(all(unix, not(target_os = "macos")))]
use secret_service as sys;
#[cfg(windows)]
mod credential_manager;
#[cfg(windows)]
use credential_manager as sys;

/// The environment variable that selects the store: `file` selects the
/// owner-only file ([`SecretStoreMode::File`]); unset or anything else, the
/// system store.
pub const STORE_VARIABLE: &str = "BUTLER_SECRET_STORE";

/// The service every Butler secret is stored under.
pub const SERVICE: &str = "Butler";

/// Which store a process asked for.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SecretStoreMode {
    /// The operating system's credential store, else the owner-only file.
    #[default]
    System,
    /// The owner-only file only: tests and end-to-end runs, which must never
    /// touch the user's credential store.
    File,
}

impl SecretStoreMode {
    /// The mode a [`STORE_VARIABLE`] value selects: `file` selects
    /// [`Self::File`], anything else [`Self::System`].
    pub fn from_setting(value: Option<&str>) -> Self {
        match value.map(str::trim) {
            Some(value) if value.eq_ignore_ascii_case("file") => Self::File,
            _ => Self::System,
        }
    }

    /// The mode this process's [`STORE_VARIABLE`] selects.
    pub fn from_environment() -> Self {
        Self::from_setting(std::env::var(STORE_VARIABLE).ok().as_deref())
    }

    /// `system` or `file`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::File => "file",
        }
    }
}

/// Where secrets are kept.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SecretBackend {
    /// The macOS login Keychain.
    Keychain,
    /// A Secret Service (GNOME Keyring, KWallet) over the D-Bus session bus.
    SecretService,
    /// The Windows Credential Manager.
    CredentialManager,
    /// An owner-only file in the data folder.
    FallbackFile,
}

impl SecretBackend {
    /// The stable public name: `keychain`, `secret_service`,
    /// `credential_manager` or `fallback_file`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Keychain => "keychain",
            Self::SecretService => "secret_service",
            Self::CredentialManager => "credential_manager",
            Self::FallbackFile => "fallback_file",
        }
    }

    /// The backend a public name names.
    pub fn from_name(name: &str) -> Option<Self> {
        [
            Self::Keychain,
            Self::SecretService,
            Self::CredentialManager,
            Self::FallbackFile,
        ]
        .into_iter()
        .find(|backend| backend.as_str() == name)
    }

    /// Whether this is an operating-system credential store.
    pub fn is_system(self) -> bool {
        self != Self::FallbackFile
    }
}

/// What a secret is stored under: a service and an account, both non-empty
/// and free of control characters.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SecretKey {
    service: String,
    account: String,
}

impl SecretKey {
    /// The key for `account` under `service`.
    pub fn new(service: &str, account: &str) -> Result<Self, SecretError> {
        let valid = |value: &str| !value.is_empty() && !value.chars().any(char::is_control);
        if !valid(service) {
            return Err(SecretError::InvalidKey("service"));
        }
        if !valid(account) {
            return Err(SecretError::InvalidKey("account"));
        }
        Ok(Self {
            service: service.to_owned(),
            account: account.to_owned(),
        })
    }

    /// The service the secret is stored under.
    pub fn service(&self) -> &str {
        &self.service
    }

    /// The account the secret is stored under.
    pub fn account(&self) -> &str {
        &self.account
    }
}

/// A secret read from a store. It is wiped from memory when dropped and its
/// `Debug` output is redacted.
pub struct SecretText(Zeroizing<String>);

impl SecretText {
    /// Wraps `secret`.
    pub fn new(secret: String) -> Self {
        Self(Zeroizing::new(secret))
    }

    /// The secret itself; keep the borrow as short as possible.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for SecretText {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SecretText(<redacted>)")
    }
}

/// Why a secret operation failed. No variant carries secret bytes.
#[derive(Debug, thiserror::Error)]
pub enum SecretError {
    /// The credential store could not be reached (no D-Bus session or no
    /// Secret Service, for example).
    #[error("the credential store is unavailable")]
    Unavailable(#[source] keyring_core::Error),
    /// The credential store refused access (locked, or access denied).
    #[error("the credential store refused access")]
    AccessDenied(#[source] keyring_core::Error),
    /// The credential store failed the operation.
    #[error("the credential store failed")]
    Store(#[source] keyring_core::Error),
    /// The stored value is not a text secret.
    #[error("the stored secret is not text")]
    NotText,
    /// The owner-only secret file could not be read or written.
    #[error("the secret file could not be read or written")]
    File(#[source] std::io::Error),
    /// The owner-only secret file is not JSON (the error names a position,
    /// never the text there).
    #[error("the secret file is not valid JSON")]
    FileFormat(#[source] serde_json::Error),
    /// The owner-only secret file is JSON of another shape or version.
    #[error("the secret file has an unknown shape")]
    FileShape,
    /// A key's service or account is empty or has control characters.
    #[error("the secret {0} is empty or has control characters")]
    InvalidKey(&'static str),
}

impl SecretError {
    /// A stable code for reports: `unavailable`, `access_denied`,
    /// `store_failed`, `not_text`, `file_failed`, `file_malformed` or
    /// `invalid_key`.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Unavailable(_) => "unavailable",
            Self::AccessDenied(_) => "access_denied",
            Self::Store(_) => "store_failed",
            Self::NotText => "not_text",
            Self::File(_) => "file_failed",
            Self::FileFormat(_) | Self::FileShape => "file_malformed",
            Self::InvalidKey(_) => "invalid_key",
        }
    }
}

/// A credential store: the system's, or the owner-only file. Cheap to clone;
/// clones share the store.
#[derive(Clone)]
pub struct SecretStore {
    backend: SecretBackend,
    inner: Inner,
}

#[derive(Clone)]
enum Inner {
    System(Arc<keyring_core::CredentialStore>),
    File(Arc<file::FileSecrets>),
}

impl fmt::Debug for SecretStore {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SecretStore")
            .field("backend", &self.backend)
            .finish_non_exhaustive()
    }
}

impl SecretStore {
    /// Opens this system's credential store and checks that it answers (a
    /// lookup of a key that does not exist). May block, and on a desktop may
    /// ask the user to unlock the store.
    pub fn system() -> Result<Self, SecretError> {
        let store = sys::open()?;
        let opened = Self {
            backend: sys::BACKEND,
            inner: Inner::System(store),
        };
        let probe = SecretKey::new(SERVICE, "availability-probe")?;
        match opened.get(&probe) {
            Ok(_) => Ok(opened),
            Err(SecretError::AccessDenied(source) | SecretError::Store(source)) => {
                Err(SecretError::Unavailable(source))
            }
            Err(error) => Err(error),
        }
    }

    /// The owner-only secret file at `path` (created on the first write,
    /// with its missing parent directories owner-only too).
    pub fn file(path: PathBuf) -> Self {
        Self {
            backend: SecretBackend::FallbackFile,
            inner: Inner::File(Arc::new(file::FileSecrets::new(path))),
        }
    }

    /// Where this store keeps secrets.
    pub fn backend(&self) -> SecretBackend {
        self.backend
    }

    /// The secret stored under `key`; `None` when there is none.
    pub fn get(&self, key: &SecretKey) -> Result<Option<SecretText>, SecretError> {
        match &self.inner {
            Inner::System(store) => match entry(store.as_ref(), key)?.get_password() {
                Ok(secret) => Ok(Some(SecretText::new(secret))),
                Err(keyring_core::Error::NoEntry) => Ok(None),
                Err(error) => Err(store_error(error)),
            },
            Inner::File(file) => file.get(key),
        }
    }

    /// Stores `secret` under `key`, replacing a secret stored there.
    pub fn set(&self, key: &SecretKey, secret: &str) -> Result<(), SecretError> {
        match &self.inner {
            Inner::System(store) => entry(store.as_ref(), key)?
                .set_password(secret)
                .map_err(store_error),
            Inner::File(file) => file.set(key, secret),
        }
    }

    /// Removes the secret stored under `key`; false when there was none.
    pub fn delete(&self, key: &SecretKey) -> Result<bool, SecretError> {
        match &self.inner {
            Inner::System(store) => match entry(store.as_ref(), key)?.delete_credential() {
                Ok(()) => Ok(true),
                Err(keyring_core::Error::NoEntry) => Ok(false),
                Err(error) => Err(store_error(error)),
            },
            Inner::File(file) => file.delete(key),
        }
    }
}

fn entry(
    store: &keyring_core::CredentialStore,
    key: &SecretKey,
) -> Result<keyring_core::Entry, SecretError> {
    store
        .build(&key.service, &key.account, None)
        .map_err(store_error)
}

/// Converts a store error, dropping any secret bytes it carries.
fn store_error(error: keyring_core::Error) -> SecretError {
    match error {
        keyring_core::Error::NoStorageAccess(_) => SecretError::AccessDenied(error),
        keyring_core::Error::BadEncoding(_) => SecretError::NotText,
        keyring_core::Error::BadDataFormat(_, source) => {
            SecretError::Store(keyring_core::Error::PlatformFailure(source))
        }
        other => SecretError::Store(other),
    }
}
