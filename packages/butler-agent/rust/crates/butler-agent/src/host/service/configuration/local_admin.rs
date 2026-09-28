//! The local admin credential (#229): a secret in the data folder,
//! `app/runtime/auth/local-admin.json` (0600, created by the agent like the
//! gateway token). Only the App and the CLI on this computer read it; they
//! send it in `X-Butler-Admin` to reach Settings → Security. A client that
//! merely connects from loopback (a header-less TCP forwarder, a container
//! reaching the host) has the gateway token at most, never this file.
//!
//! It is not the connection code: rotating the code leaves it unchanged,
//! and it is never shown or sent to a remote client.

use std::path::Path;

use base64::Engine;
use serde::{Deserialize, Serialize};

use super::local_credentials::{CredentialFiles, LocalCredentialError, load_file};

/// Where the admin credential lives, relative to the data folder.
const LOCAL_ADMIN_FILE: &str = "app/runtime/auth/local-admin.json";
const ADMIN_SCHEMA: &str = "butler.app-local-admin.v1";
const MIN_SECRET_LENGTH: usize = 32;

/// The file's fields the agent reads.
#[derive(Deserialize)]
struct StoredAdmin {
    #[serde(default)]
    schema: Option<String>,
    #[serde(default)]
    secret: Option<String>,
}

#[derive(Serialize)]
struct NewAdminFile {
    schema: &'static str,
    purpose: &'static str,
    secret: String,
    created_at: String,
}

/// The admin credential of `data_root`, created when `files` allows.
pub(super) fn load(
    data_root: &Path,
    files: CredentialFiles,
) -> Result<String, LocalCredentialError> {
    load_file(
        &data_root.join(LOCAL_ADMIN_FILE),
        files,
        usable_admin,
        new_admin_file,
    )
}

fn usable_admin(bytes: &[u8]) -> Option<String> {
    let stored = serde_json::from_slice::<StoredAdmin>(bytes).ok()?;
    let secret = stored.secret?;
    (stored.schema.as_deref() == Some(ADMIN_SCHEMA) && secret.len() >= MIN_SECRET_LENGTH)
        .then_some(secret)
}

fn new_admin_file() -> Result<Vec<u8>, LocalCredentialError> {
    let mut bytes = [0_u8; 32];
    bytes[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    bytes[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    let file = NewAdminFile {
        schema: ADMIN_SCHEMA,
        purpose: "butler-local-admin",
        secret: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes),
        created_at: butler_core::js_date::iso_from_system_time(std::time::SystemTime::now()),
    };
    serde_json::to_vec_pretty(&file).map_err(LocalCredentialError::Encode)
}
