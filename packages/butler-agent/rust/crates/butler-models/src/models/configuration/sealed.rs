//! Remote model credentials are encrypted to the main's age identity. The
//! remote keeps only its public recipient on disk. Unlock supplies the identity
//! in memory until the remote exits.
//!
//! On macOS the remote runs a checksum-verified official release archive,
//! signed with Developer ID and hardened runtime, without get-task-allow.
//! Same-user lldb, task_for_pid and leaks were refused in the 2026-11-21 test.
//! On Linux the SSH probe and deploy script require Yama ptrace_scope >= 1,
//! which denies memory access from unrelated same-user processes. Debian can
//! ship scope 0. The service keeps its normal process identity for start/stop.
//! Root and administrators are outside this protection.

use std::{
    collections::BTreeMap,
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::OnceLock,
};

use age::x25519::{Identity, Recipient};
use butler_platform::{
    secrets::{SecretBackend, SecretText},
    secure_fs,
};
use chrono::{DateTime, TimeDelta, Utc};
use parking_lot::{Mutex, RwLock};

use super::credentials::{CREDENTIALS_FILE, CredentialsFile};

const MAP: &str = "auth/remote-credentials.age";

struct State {
    enabled: bool,
    identity: Option<Identity>,
    data_root: PathBuf,
}

static STATE: OnceLock<RwLock<State>> = OnceLock::new();

#[derive(Debug, thiserror::Error)]
pub enum SealedError {
    #[error("The remote is waiting for its account key.")]
    KeyPending,
    #[error("The account key does not match this remote.")]
    KeyMismatch,
    #[error("Invalid account key.")]
    InvalidIdentity,
    #[error("The remote account file could not be used.")]
    Storage(#[from] io::Error),
}

impl SealedError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::KeyPending => "remote_key_pending",
            Self::KeyMismatch => "remote_key_mismatch",
            Self::InvalidIdentity => "invalid_json",
            Self::Storage(_) => "credential_store_failed",
        }
    }
}

/// A new account identity for one remote computer (kept by the main).
pub fn new_identity() -> SecretText {
    use age::secrecy::ExposeSecret;
    SecretText::new(Identity::generate().to_string().expose_secret().to_owned())
}

pub fn enable(data_root: &Path) {
    STATE.get_or_init(|| {
        RwLock::new(State {
            enabled: true,
            identity: None,
            data_root: data_root.to_owned(),
        })
    });
}

pub fn is_enabled() -> bool {
    STATE.get().is_some_and(|state| state.read().enabled)
}

/// Whether sealed mode is on and the main has not handed over its key yet.
pub fn is_locked() -> bool {
    STATE.get().is_some_and(|state| {
        let state = state.read();
        state.enabled && state.identity.is_none()
    })
}

pub fn unlock(identity: &str) -> Result<(), SealedError> {
    butler_log::register_secret(identity);
    let identity: Identity = identity.parse().map_err(|_| SealedError::InvalidIdentity)?;
    let mut state = STATE.get().ok_or(SealedError::KeyPending)?.write();
    let remote = state.data_root.join("remote");
    secure_fs::create_private_dir_all(&remote)?;
    let path = remote.join("account.pub");
    let public = identity.to_public().to_string();
    let create = match fs::read_to_string(&path) {
        Ok(text) if text.trim() == public => false,
        Ok(_) => return Err(SealedError::KeyMismatch),
        Err(error) if error.kind() == io::ErrorKind::NotFound => true,
        Err(error) => return Err(SealedError::Storage(error)),
    };
    secure_fs::replace_private(
        &remote.join("last-unlock"),
        |file| file.write_all(Utc::now().to_rfc3339().as_bytes()),
        std::convert::identity,
    )?;
    if create {
        secure_fs::replace_private(
            &path,
            |file| file.write_all(public.as_bytes()),
            std::convert::identity,
        )?;
    }
    state.identity = Some(identity);
    Ok(())
}

pub fn seal(plain: &[u8]) -> Result<Vec<u8>, SealedError> {
    let state = STATE.get().ok_or(SealedError::KeyPending)?.read();
    let text = fs::read_to_string(state.data_root.join("remote/account.pub")).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            SealedError::KeyPending
        } else {
            SealedError::Storage(error)
        }
    })?;
    let recipient: Recipient = text.trim().parse().map_err(io::Error::other)?;
    age::encrypt(&recipient, plain).map_err(|error| SealedError::Storage(io::Error::other(error)))
}

pub fn open(cipher: &[u8]) -> Result<Vec<u8>, SealedError> {
    let state = STATE.get().ok_or(SealedError::KeyPending)?.read();
    age::decrypt(
        state.identity.as_ref().ok_or(SealedError::KeyPending)?,
        cipher,
    )
    .map_err(|error| SealedError::Storage(io::Error::other(error)))
}

pub fn read_map() -> Result<BTreeMap<String, String>, SealedError> {
    let path = {
        let state = STATE.get().ok_or(SealedError::KeyPending)?.read();
        state.identity.as_ref().ok_or(SealedError::KeyPending)?;
        state.data_root.join(MAP)
    };
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&open(&bytes)?)
            .map_err(|error| SealedError::Storage(io::Error::other(error))),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(error) => Err(SealedError::Storage(error)),
    }
}

/// Return `Some` to commit a change, or `None` to leave the file alone.
pub(crate) fn update_map<T>(
    update: impl FnOnce(&mut BTreeMap<String, String>) -> Option<T>,
) -> Result<Option<T>, SealedError> {
    static WRITES: Mutex<()> = Mutex::new(());
    let _write = WRITES.lock();
    let mut map = read_map()?;
    let result = update(&mut map);
    if result.is_some() {
        write_map(&map)?;
    }
    Ok(result)
}

fn write_map(map: &BTreeMap<String, String>) -> Result<(), SealedError> {
    let root = STATE
        .get()
        .ok_or(SealedError::KeyPending)?
        .read()
        .data_root
        .clone();
    let path = root.join(MAP);
    let bytes = seal(&serde_json::to_vec(map).map_err(io::Error::other)?)?;
    secure_fs::create_private_dir_all(&root.join("auth"))?;
    secure_fs::replace_private(&path, |file| file.write_all(&bytes), std::convert::identity)
        .map_err(SealedError::Storage)
}

/// Forget the account if the main has not unlocked it in over 30 days.
pub fn expire(root: &Path) -> Result<(), SealedError> {
    let timestamp = match fs::read_to_string(root.join("remote/last-unlock")) {
        Ok(text) => DateTime::parse_from_rfc3339(text.trim()).map_err(io::Error::other)?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(SealedError::Storage(error)),
    };
    if Utc::now().signed_duration_since(timestamp) <= TimeDelta::days(30) {
        return Ok(());
    }
    let private = butler_core::configuration::read_private_environment(
        &root.join(butler_platform::data_paths::ENVIRONMENT),
    )
    .map_err(io::Error::other)?;
    let mut environment = super::ModelConfigurationEnvironment {
        chatgpt_auth_dir: std::env::var("BUTLER_CHATGPT_AUTH_DIR")
            .ok()
            .filter(|dir| !dir.is_empty())
            .map(PathBuf::from),
        ..Default::default()
    };
    super::environment::merge_private_auth_environment(&mut environment, &private);
    let registration =
        super::chatgpt::store::paths(root, environment.chatgpt_auth_dir.as_deref()).registration;
    let metadata = root.join(CREDENTIALS_FILE);
    let mut file = CredentialsFile::load(&metadata).map_err(io::Error::other)?;
    let before = file.entries().len();
    file.entries_mut()
        .retain(|record| record["storage"].as_str() != Some(SecretBackend::FallbackFile.as_str()));
    if file.entries().len() != before {
        file.save(&metadata).map_err(io::Error::other)?;
    }
    for path in [
        root.join(MAP),
        registration,
        root.join("remote/account.pub"),
    ] {
        match fs::remove_file(path) {
            Ok(()) => (),
            Err(error) if error.kind() == io::ErrorKind::NotFound => (),
            Err(error) => return Err(SealedError::Storage(error)),
        }
    }
    Ok(())
}
