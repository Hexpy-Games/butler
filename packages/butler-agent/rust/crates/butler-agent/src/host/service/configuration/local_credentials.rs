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
    /// The file is missing or holds no usable credential: a read-only load,
    /// an override file, or a file still unusable after it was written.
    #[error("the credential file {path} holds no usable credential")]
    Unusable { path: PathBuf },
}

impl LocalCredentialError {
    /// A stable code for service diagnostics and CLI errors.
    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::Directory { .. } => "local_credential_directory_unavailable",
            Self::Read { .. } => "local_credential_unreadable",
            Self::Write { .. } => "local_credential_unwritable",
            Self::Encode(_) => "local_credential_encode_failed",
            Self::Unusable { .. } => "local_credential_unusable",
        }
    }

    /// The file or directory concerned, when there is one.
    pub(crate) fn path(&self) -> Option<&Path> {
        match self {
            Self::Directory { path, .. }
            | Self::Read { path, .. }
            | Self::Write { path, .. }
            | Self::Unusable { path } => Some(path),
            Self::Encode(_) => None,
        }
    }

    /// One log line: code, path and the cause chain (never a credential).
    pub(crate) fn diagnostic(&self) -> String {
        use std::error::Error as _;
        use std::fmt::Write as _;
        let mut line = format!("code={}", self.code());
        // Writing to a String cannot fail.
        if let Some(path) = self.path() {
            let _ = write!(line, " path={}", path.display());
        }
        let mut cause = self.source();
        let mut separator = " error=";
        while let Some(error) = cause {
            let _ = write!(line, "{separator}{error}");
            separator = ": ";
            cause = error.source();
        }
        line
    }
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

/// The token in the data folder's own token file, when it is usable, whatever
/// `BUTLER_APP_LOCAL_AUTH_FILE` names: the token of an agent started without
/// that override. Only read, never created.
pub(crate) fn data_folder_token(data_root: &Path) -> Option<String> {
    usable_token(&fs::read(data_root.join(LOCAL_AUTH_FILE)).ok()?)
}

/// The file the gateway token is loaded from: `BUTLER_APP_LOCAL_AUTH_FILE`
/// when set (the App names the data folder's file there), else the data
/// folder's own file.
pub(crate) fn token_file(data_root: &Path) -> PathBuf {
    env_value("BUTLER_APP_LOCAL_AUTH_FILE")
        .map_or_else(|| data_root.join(LOCAL_AUTH_FILE), PathBuf::from)
}

/// When the token in `path` was created, as the file records it.
pub(crate) fn token_created_at(path: &Path) -> Result<Option<String>, LocalCredentialError> {
    let bytes = fs::read(path).map_err(|source| LocalCredentialError::Read {
        path: path.to_path_buf(),
        source,
    })?;
    Ok(serde_json::from_slice::<StoredToken>(&bytes)
        .ok()
        .and_then(|stored| stored.created_at))
}

/// A token [`rotate_token`] wrote.
pub(crate) struct RotatedToken {
    pub(crate) token: String,
    pub(crate) created_at: String,
}

/// Replaces the token file at `path` with a new token: a private temporary
/// file renamed over it, so readers see the old file or the new one, never
/// a partial one.
pub(crate) fn rotate_token(path: &Path) -> Result<RotatedToken, LocalCredentialError> {
    let file = NewTokenFile::generate();
    let contents = serde_json::to_vec_pretty(&file).map_err(LocalCredentialError::Encode)?;
    let write_error = |source| LocalCredentialError::Write {
        path: path.to_path_buf(),
        source,
    };
    let parent = path.parent().unwrap_or(Path::new("."));
    let temporary = parent.join(format!(".credential-{}.tmp", uuid::Uuid::new_v4()));
    let result = write_private(&temporary, &contents).and_then(|()| fs::rename(&temporary, path));
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(write_error)?;
    Ok(RotatedToken {
        token: file.token,
        created_at: file.created_at,
    })
}

/// The token file's fields the agent reads; the App writes more.
#[derive(Deserialize)]
struct StoredToken {
    #[serde(default)]
    schema: Option<String>,
    #[serde(default)]
    token: Option<String>,
    #[serde(default)]
    created_at: Option<String>,
}

/// The App's token file format, so either side can create it.
#[derive(Serialize)]
struct NewTokenFile {
    schema: &'static str,
    product: &'static str,
    purpose: &'static str,
    token: String,
    created_at: String,
    raw_text_included: bool,
}

impl NewTokenFile {
    /// A new random token (256 bits, base64url), created now.
    fn generate() -> Self {
        let mut bytes = [0_u8; 32];
        bytes[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
        bytes[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
        Self {
            schema: TOKEN_SCHEMA,
            product: "butler-app",
            purpose: "bundled-agent-local-auth",
            token: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes),
            created_at: butler_core::js_date::iso_from_system_time(std::time::SystemTime::now()),
            raw_text_included: false,
        }
    }
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
    serde_json::to_vec_pretty(&NewTokenFile::generate()).map_err(LocalCredentialError::Encode)
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
