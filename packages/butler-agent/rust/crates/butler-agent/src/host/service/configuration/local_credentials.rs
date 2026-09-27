//! Credentials owned by the data folder, so the App, the CLI and an agent
//! started by either (or by launchd) agree on them without passing them:
//!
//! - `app/runtime/auth/local-agent-auth.json`: the gateway bearer token, in
//!   the App's `butler.app-local-agent-auth.v1` format.
//! - `state/app-gateway/project-folder-token-secret`: the key of the App's
//!   project-folder selection tokens.
//!
//! A missing or unusable file is created (0600 in a 0700 directory, written
//! to a temporary file and linked into place, so concurrent creators agree on
//! the first one). `BUTLER_APP_LOCAL_AUTH_FILE` (a token file elsewhere) and
//! `BUTLER_PROJECT_FOLDER_TOKEN_SECRET` still win.

use std::fs::{self, DirBuilder, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

use base64::Engine;
use serde::{Deserialize, Serialize};

use butler_core::public_text::trim_js_whitespace;

/// Where the gateway token lives, relative to the data folder.
const LOCAL_AUTH_FILE: &str = "app/runtime/auth/local-agent-auth.json";
const FOLDER_SECRET_FILE: &str = "state/app-gateway/project-folder-token-secret";
const TOKEN_SCHEMA: &str = "butler.app-local-agent-auth.v1";
/// The App regenerates shorter tokens; the agent treats them the same way.
const MIN_TOKEN_LENGTH: usize = 32;

/// Why a data-folder credential could not be read or created.
#[derive(Debug, thiserror::Error)]
pub(crate) enum LocalCredentialError {
    /// The credential directory could not be created.
    #[error("cannot create the credential directory {path}")]
    Directory {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    /// The credential file could not be read.
    #[error("cannot read the credential file {path}")]
    Read {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    /// The new credential could not be written into place.
    #[error("cannot write the credential file {path}")]
    Write {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    /// The token file could not be encoded.
    #[error("cannot encode the local auth file")]
    Encode(#[source] serde_json::Error),
    /// The file is still unusable right after it was written.
    #[error("the credential file {path} is unusable after it was written")]
    Unusable { path: PathBuf },
}

/// Whether loading may create the credential files.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CredentialFiles {
    /// Only read them (CLI commands, listener reconfiguration).
    ReadOnly,
    /// Create missing or unusable ones (the service and its start command,
    /// for a data folder Butler will run on).
    CreateMissing,
}

/// The gateway token and the folder-selection secret for one data folder.
pub(crate) struct LocalCredentials {
    /// The bearer token every gateway client presents.
    pub(crate) token: Result<String, LocalCredentialError>,
    /// The project-folder selection secret.
    pub(crate) folder_secret: Result<String, LocalCredentialError>,
}

impl LocalCredentials {
    /// Reads both credentials, creating them when `files` allows;
    /// environment overrides win.
    pub(crate) fn load(data_root: &Path, files: CredentialFiles) -> Self {
        let token = match env_value("BUTLER_APP_LOCAL_AUTH_FILE") {
            Some(path) => read_token_override(Path::new(&path)),
            None => load_file(
                &data_root.join(LOCAL_AUTH_FILE),
                files,
                usable_token,
                new_token_file,
            ),
        };
        let folder_secret = match env_value("BUTLER_PROJECT_FOLDER_TOKEN_SECRET") {
            Some(secret) => Ok(secret),
            None => load_file(
                &data_root.join(FOLDER_SECRET_FILE),
                files,
                usable_secret,
                new_secret_file,
            ),
        };
        Self {
            token,
            folder_secret,
        }
    }
}

/// The token file's fields the agent reads; the App writes more.
#[derive(Deserialize)]
struct StoredToken {
    #[serde(default)]
    schema: Option<String>,
    #[serde(default)]
    token: Option<String>,
}

/// The App's token file format, so either side can create it.
#[derive(Serialize)]
struct NewTokenFile<'a> {
    schema: &'a str,
    product: &'a str,
    purpose: &'a str,
    token: &'a str,
    created_at: String,
    raw_text_included: bool,
}

/// An override file is used as given: any non-blank `token`.
fn read_token_override(path: &Path) -> Result<String, LocalCredentialError> {
    let bytes = fs::read(path).map_err(|source| LocalCredentialError::Read {
        path: path.to_path_buf(),
        source,
    })?;
    serde_json::from_slice::<StoredToken>(&bytes)
        .ok()
        .and_then(|stored| stored.token)
        .map(|token| trim_js_whitespace(&token).to_owned())
        .filter(|token| !token.is_empty())
        .ok_or_else(|| LocalCredentialError::Unusable {
            path: path.to_path_buf(),
        })
}

fn usable_token(bytes: &[u8]) -> Option<String> {
    let stored = serde_json::from_slice::<StoredToken>(bytes).ok()?;
    let token = stored.token?;
    (stored.schema.as_deref() == Some(TOKEN_SCHEMA) && token.len() >= MIN_TOKEN_LENGTH)
        .then_some(token)
}

fn usable_secret(bytes: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(bytes).ok()?;
    let secret = trim_js_whitespace(text);
    (!secret.is_empty()).then(|| secret.to_owned())
}

fn new_token_file() -> Result<Vec<u8>, LocalCredentialError> {
    let mut bytes = [0_u8; 32];
    bytes[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    bytes[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    let file = NewTokenFile {
        schema: TOKEN_SCHEMA,
        product: "butler-app",
        purpose: "bundled-agent-local-auth",
        token: &token,
        created_at: butler_core::js_date::iso_from_system_time(std::time::SystemTime::now()),
        raw_text_included: false,
    };
    serde_json::to_vec_pretty(&file).map_err(LocalCredentialError::Encode)
}

fn new_secret_file() -> Result<Vec<u8>, LocalCredentialError> {
    Ok(format!("{}\n", uuid::Uuid::new_v4()).into_bytes())
}

/// The usable value at `path`; when it is missing or unusable and `files`
/// allows, the file is created with `create`.
fn load_file(
    path: &Path,
    files: CredentialFiles,
    usable: fn(&[u8]) -> Option<String>,
    create: fn() -> Result<Vec<u8>, LocalCredentialError>,
) -> Result<String, LocalCredentialError> {
    if let Some(value) = read_usable(path, usable)? {
        return Ok(value);
    }
    if files == CredentialFiles::CreateMissing {
        publish(path, &create()?, usable)?;
    }
    read_usable(path, usable)?.ok_or_else(|| LocalCredentialError::Unusable {
        path: path.to_path_buf(),
    })
}

fn read_usable(
    path: &Path,
    usable: fn(&[u8]) -> Option<String>,
) -> Result<Option<String>, LocalCredentialError> {
    match fs::read(path) {
        Ok(bytes) => Ok(usable(&bytes)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(source) => Err(LocalCredentialError::Read {
            path: path.to_path_buf(),
            source,
        }),
    }
}

/// Links a private temporary file into place. When another process created
/// a usable file first, that one stays; an unusable one is replaced.
fn publish(
    path: &Path,
    contents: &[u8],
    usable: fn(&[u8]) -> Option<String>,
) -> Result<(), LocalCredentialError> {
    let write_error = |source| LocalCredentialError::Write {
        path: path.to_path_buf(),
        source,
    };
    let parent = path.parent().unwrap_or(Path::new("."));
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(parent)
        .map_err(|source| LocalCredentialError::Directory {
            path: parent.to_path_buf(),
            source,
        })?;
    let temporary = parent.join(format!(".credential-{}.tmp", uuid::Uuid::new_v4()));
    let result =
        write_private(&temporary, contents).and_then(|()| match fs::hard_link(&temporary, path) {
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                let current = fs::read(path).ok();
                if current.as_deref().and_then(usable).is_some() {
                    Ok(())
                } else {
                    fs::rename(&temporary, path)
                }
            }
            other => other,
        });
    let _ = fs::remove_file(&temporary);
    result.map_err(write_error)
}

fn write_private(path: &Path, contents: &[u8]) -> io::Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(contents)?;
    file.sync_all()
}

fn env_value(name: &str) -> Option<String> {
    std::env::var(name).ok().and_then(|value| {
        let value = trim_js_whitespace(&value);
        (!value.is_empty()).then(|| value.to_owned())
    })
}
