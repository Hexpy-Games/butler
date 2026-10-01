//! Which store new API keys go to (#217). The owner-only file in the data
//! folder is the default. The system store (Keychain, Secret Service,
//! Credential Manager) is used when the build is Developer ID signed (macOS:
//! its Keychain access then survives updates) or when the configuration
//! asks for it (`secrets.store = "system"`); `secrets.store = "file"` keeps
//! the file even for a signed build. A test harness sets
//! `BUTLER_SECRET_STORE=file`, which is honored for data folders other than
//! the user's own (`~/.butler`) and ignored, with a warning, for it.

use std::path::Path;

use butler_platform::secrets::{
    STORE_VARIABLE, SYSTEM_BACKEND, SecretStoreMode, developer_id_signed,
};
use serde::Serialize;
use serde_json::Value;

use super::read_object_sync;
use crate::models::CredentialStorage;

/// Host facts that choose where API keys are kept. The `Default` (an
/// unsigned build, no override) keeps them in the owner-only file, so a
/// test never touches the user's credential store.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SecretStoreFacts {
    /// The running agent is Developer ID signed (macOS).
    pub signed_build: bool,
    /// What became of `BUTLER_SECRET_STORE=file`.
    pub file_override: FileOverride,
}

/// `BUTLER_SECRET_STORE=file` as the host resolved it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum FileOverride {
    /// Not set.
    #[default]
    None,
    /// Set for a data folder other than the user's own: honored.
    Honored,
    /// Set for the user's own data folder: ignored.
    IgnoredForDefaultDataRoot,
}

impl SecretStoreFacts {
    /// This process's facts for `data_root`: its signature, and
    /// `BUTLER_SECRET_STORE` (honored unless `data_root` is
    /// `default_data_root`, the user's own `~/.butler`).
    pub fn capture(data_root: &Path, default_data_root: Option<&Path>) -> Self {
        let requested = std::env::var(STORE_VARIABLE)
            .ok()
            .and_then(|value| SecretStoreMode::parse(&value))
            == Some(SecretStoreMode::File);
        let file_override = match (requested, default_data_root) {
            (false, _) => FileOverride::None,
            (true, Some(default)) if same_folder(data_root, default) => {
                FileOverride::IgnoredForDefaultDataRoot
            }
            (true, _) => FileOverride::Honored,
        };
        Self {
            signed_build: developer_id_signed(),
            file_override,
        }
    }
}

impl SecretStoreFacts {
    /// [`Self::capture`] with the user's own data folder (`~/.butler`).
    pub fn for_data_root(data_root: &Path) -> Self {
        let default = butler_platform::user_dirs::home_dir().map(|home| home.join(".butler"));
        Self::capture(data_root, default.as_deref())
    }
}

fn same_folder(left: &Path, right: &Path) -> bool {
    let resolve = |path: &Path| std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    resolve(left) == resolve(right)
}

/// Why new keys go where they go.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StoreReason {
    /// The build is not Developer ID signed and the configuration does not
    /// ask for the system store: the owner-only file.
    UnsignedBuild,
    /// The build is Developer ID signed: the system store.
    SignedBuild,
    /// `secrets.store` in the configuration.
    Config,
    /// `BUTLER_SECRET_STORE=file` for a data folder other than the user's
    /// own (test harnesses): the owner-only file.
    TestOverride,
}

/// The store new keys go to and why.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct StoreChoice {
    pub(super) mode: SecretStoreMode,
    pub(super) reason: StoreReason,
}

/// The choice for the data root whose configuration is `config`.
pub(super) fn choose(facts: SecretStoreFacts, config: &Value) -> StoreChoice {
    if facts.file_override == FileOverride::Honored {
        return StoreChoice {
            mode: SecretStoreMode::File,
            reason: StoreReason::TestOverride,
        };
    }
    let configured = config
        .pointer("/secrets/store")
        .and_then(Value::as_str)
        .and_then(SecretStoreMode::parse);
    match configured {
        Some(mode) => StoreChoice {
            mode,
            reason: StoreReason::Config,
        },
        None if facts.signed_build => StoreChoice {
            mode: SecretStoreMode::System,
            reason: StoreReason::SignedBuild,
        },
        None => StoreChoice {
            mode: SecretStoreMode::File,
            reason: StoreReason::UnsignedBuild,
        },
    }
}

/// The store policy of a data root as `butler doctor` reports it, decided
/// without opening any store.
#[derive(Clone, Debug, Serialize)]
pub struct CredentialStorePolicy {
    /// `system` or `file`.
    pub store: &'static str,
    /// The system store of this OS (`keychain`, `secret_service`,
    /// `credential_manager`), used when `store` is `system`.
    pub system_backend: CredentialStorage,
    pub reason: StoreReason,
    /// `BUTLER_SECRET_STORE=file` was ignored for the user's own data folder.
    pub override_ignored: bool,
}

/// The policy for `data_root` with `facts` (reads its configuration only).
pub fn credential_store_policy(data_root: &Path, facts: SecretStoreFacts) -> CredentialStorePolicy {
    let choice = choose(
        facts,
        &read_object_sync(&data_root.join("butler.config.json")),
    );
    CredentialStorePolicy {
        store: choice.mode.as_str(),
        system_backend: SYSTEM_BACKEND.into(),
        reason: choice.reason,
        override_ignored: facts.file_override == FileOverride::IgnoredForDefaultDataRoot,
    }
}
