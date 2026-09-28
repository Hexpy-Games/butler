//! Secrets in a credential store (#217): the operating system's (the macOS
//! Keychain, the Secret Service on Linux over D-Bus, the Windows Credential
//! Manager) or an owner-only file in the data folder
//! ([`SecretBackend::FallbackFile`]). Which one a caller uses is its policy;
//! this module supplies the stores, the facts that policy needs
//! ([`developer_id_signed`]) and the pieces around them: a cross-process
//! [`ChangeLock`] for read-modify-write cycles and [`read_secret_input`] for
//! typing a secret without echo.
//!
//! A secret is addressed by a [`SecretKey`]: a service and an account. Every
//! operation is blocking; async callers run it on a blocking thread. Secrets
//! come back as [`SecretText`], which is wiped from memory when dropped and
//! never prints.

use std::fmt;
use std::fs::{File, OpenOptions, TryLockError};
use std::io::{self, BufRead, IsTerminal};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use zeroize::Zeroizing;

use crate::secure_fs;

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

/// The environment variable a test harness sets to `file` so a data folder
/// other than the user's own never uses the system store.
pub const STORE_VARIABLE: &str = "BUTLER_SECRET_STORE";

/// The service of the lookup [`SecretStore::system`] probes the store with.
const PROBE_SERVICE: &str = "com.hexpy.butler.store-probe";

/// The system store of this operating system.
pub const SYSTEM_BACKEND: SecretBackend = sys::BACKEND;

/// Which store a caller uses.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SecretStoreMode {
    /// The operating system's credential store.
    System,
    /// The owner-only file in the data folder. The default, so nothing
    /// touches the user's credential store unless a policy turns it on.
    #[default]
    File,
}

impl SecretStoreMode {
    /// `system` or `file` (either case, surrounding whitespace ignored).
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "system" => Some(Self::System),
            "file" => Some(Self::File),
            _ => None,
        }
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

/// Whether the running program carries a valid Developer ID signature
/// (macOS; always false elsewhere). Checked once per process. The system
/// store trusts a program by its signature, so an unsigned or ad-hoc signed
/// build would be asked for access again after every update.
pub fn developer_id_signed() -> bool {
    static SIGNED: OnceLock<bool> = OnceLock::new();
    *SIGNED.get_or_init(sys::developer_id_signed)
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

    /// The secret, still wiped when its last owner drops it.
    pub fn into_zeroizing(self) -> Zeroizing<String> {
        self.0
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
    File(#[source] io::Error),
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
    /// lookup of a key that does not exist). A store that cannot be reached
    /// is [`SecretError::Unavailable`]; one that refuses the lookup keeps
    /// its [`SecretError::AccessDenied`]. May block, and on a desktop may ask
    /// the user to unlock the store.
    pub fn system() -> Result<Self, SecretError> {
        let store = sys::open()?;
        let opened = Self {
            backend: sys::BACKEND,
            inner: Inner::System(store),
        };
        opened.get(&SecretKey::new(PROBE_SERVICE, "availability-probe")?)?;
        Ok(opened)
    }

    /// The owner-only secret file at `path` (created on the first write,
    /// with its missing parent directories owner-only too). Changes hold a
    /// [`ChangeLock`] on `<path>.lock`, so processes sharing the file never
    /// drop each other's changes.
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

/// An exclusive advisory lock on a lock file, shared by every process that
/// takes it: a read-modify-write cycle of a file holds it so a concurrent
/// cycle (the service and a CLI command, say) cannot drop its change.
/// Released when dropped.
#[derive(Debug)]
pub struct ChangeLock {
    _file: File,
}

impl ChangeLock {
    /// Waits up to `timeout` for the lock on `path`, creating the lock file
    /// (and its missing parents) owner-only.
    pub fn acquire(path: &Path, timeout: Duration) -> io::Result<Self> {
        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            secure_fs::create_private_dir_all(parent)?;
        }
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        let _ = secure_fs::owner_only(&mut options);
        let file = options.open(path)?;
        let deadline = Instant::now() + timeout;
        loop {
            match file.try_lock() {
                Ok(()) => return Ok(Self { _file: file }),
                Err(TryLockError::WouldBlock) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(TryLockError::WouldBlock) => {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "another process holds the change lock",
                    ));
                }
                Err(TryLockError::Error(error)) => return Err(error),
            }
        }
    }
}

/// Reads one line of secret input: from the terminal with echo off (after
/// writing `prompt` to it) when standard input is a terminal, else from
/// standard input. The line ending is dropped.
pub fn read_secret_input(prompt: &str) -> io::Result<SecretText> {
    if io::stdin().is_terminal() {
        return rpassword::prompt_password(prompt).map(SecretText::new);
    }
    let mut line = Zeroizing::new(String::new());
    io::stdin().lock().read_line(&mut line)?;
    let trimmed = line.trim_end_matches(['\r', '\n']);
    Ok(SecretText::new(trimmed.to_owned()))
}
