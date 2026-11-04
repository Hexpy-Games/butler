//! `POST /internal/opened-files`: a stored file the user chose to open in
//! another app. The App names the file by id only; this side picks the target
//! and answers its path for the App to open or reveal. The latest version of a
//! delivered or agent-written file is its original, recorded at delivery and
//! never sent to clients, while that is still a regular file (not a link or a
//! folder). Otherwise this side writes a copy under the data folder's temporary
//! files and marks it as downloaded from the internet. Only content verified by
//! a positive allowlist opens; anything else is only revealed, and only as the
//! original, never as a temporary copy. The allowlist avoids OS executable
//! denylists (PATHEXT, LaunchServices, xdg), which miss .jar, .terminal and WSH
//! .js and need FFI. The copies are removed when the gateway starts and stops.
mod kind;

use std::{
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
};

use serde::Deserialize;
use serde_json::json;

use super::{
    Body, Client, HttpError, HttpState, Method, Request, Response, StatusCode, json,
    read_body_with_limit,
};
use crate::gateway::application::AppFileOrigin;
use crate::gateway::protocol::{APP_PROTOCOL_VERSION, ApiEnvelope};
use butler_platform::{data_paths, download_mark, secure_fs};

const OPENED_DIR: &str = "opened-files";
/// The most of an original read for its content check; a larger one is only revealed.
const ORIGINAL_LIMIT: u64 = 64 * 1024 * 1024;

/// What the App acts on, whether it may open, and whether it is the original.
struct Target {
    path: PathBuf,
    open: bool,
    original: bool,
}

#[derive(Deserialize)]
struct OpenRequest {
    file_id: String,
}

pub(super) async fn route(
    state: Arc<HttpState>,
    request: Request<Body>,
) -> Result<Response, HttpError> {
    if !request
        .extensions()
        .get::<Client>()
        .is_some_and(|client| client.local)
    {
        return Err(HttpError::public(
            403,
            "loopback_required",
            "Files open in another app only on this computer.",
        ));
    }
    if request.method() != Method::POST {
        return Err(HttpError::public(404, "not_found", "Route not found."));
    }
    let root = state.output_data.clone().ok_or_else(failed)?;
    let bytes = read_body_with_limit(request.into_body(), 4096).await?;
    let input: OpenRequest = serde_json::from_slice(&bytes).map_err(|_| {
        HttpError::public(400, "open_request_invalid", "Request must be {file_id}.")
    })?;
    let origin = state
        .application
        .message_file_origin(input.file_id.clone())
        .await?;
    let original = match origin {
        Some(origin) => blocking(move || Ok(original(origin))).await?,
        None => None,
    };
    let target = match original {
        Some((path, Some(handling))) => Target {
            open: matches!(handling, kind::Handling::Open(_)),
            path,
            original: true,
        },
        original => stored(&state, root, input.file_id, original.map(|(path, _)| path)).await?,
    };
    json(
        StatusCode::CREATED,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data: json!({ "path": target.path, "open": target.open, "original": target.original }),
        },
    )
}

/// The recorded original while it is a regular file, not a link or a folder.
/// Only the latest version is checked for opening, by the original's own name
/// and content; an older version opens as its stored copy.
fn original(origin: AppFileOrigin) -> Option<(PathBuf, Option<kind::Handling>)> {
    let path = PathBuf::from(origin.path);
    let regular =
        std::fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_file());
    if !regular {
        return None;
    }
    let handling = origin.latest.then(|| verify_original(&path));
    Some((path, handling))
}

fn verify_original(path: &Path) -> kind::Handling {
    let mut bytes = Vec::new();
    let read = std::fs::File::open(path)
        .and_then(|file| file.take(ORIGINAL_LIMIT + 1).read_to_end(&mut bytes));
    if read.is_err() || bytes.len() as u64 > ORIGINAL_LIMIT {
        return kind::Handling::Reveal;
    }
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    kind::verify(name, &bytes)
}

/// The stored version: a marked copy when its content may open; otherwise its
/// original is revealed, and without one there is nothing to show.
async fn stored(
    state: &HttpState,
    root: PathBuf,
    file_id: String,
    original: Option<PathBuf>,
) -> Result<Target, HttpError> {
    let download = state.application.download_message_file(file_id).await?;
    let kind::Handling::Open(extension) = kind::verify(&download.file.safe_name, &download.bytes)
    else {
        return original
            .map(|path| Target {
                path,
                open: false,
                original: true,
            })
            .ok_or_else(|| {
                HttpError::public(
                    404,
                    "original_not_found",
                    "The original file was not found.",
                )
            });
    };
    let name = copy_name(&download.file.safe_name, &extension);
    let path = blocking(move || write_marked(&root, &name, &download.bytes)).await?;
    Ok(Target {
        path,
        open: true,
        original: false,
    })
}

/// File checks and writes stay off the async workers.
async fn blocking<T: Send + 'static>(
    job: impl FnOnce() -> io::Result<T> + Send + 'static,
) -> Result<T, HttpError> {
    tokio::task::spawn_blocking(job)
        .await
        .map_err(|_| failed())?
        .map_err(|_| failed())
}

/// Removes every copy made for another app (at gateway start and stop).
pub(super) fn clear(root: &Path) -> io::Result<()> {
    secure_fs::remove_tree(&opened_dir(root))
}

fn opened_dir(root: &Path) -> PathBuf {
    root.join(data_paths::TEMPORARY).join(OPENED_DIR)
}

/// The stored name with the verified type's extension.
fn copy_name(safe_name: &str, extension: &str) -> String {
    let stem = safe_name
        .rsplit_once('.')
        .map_or(safe_name, |(stem, _)| stem)
        .replace(['/', '\\'], "_");
    let stem = if stem.trim().is_empty() {
        "file"
    } else {
        stem.as_str()
    };
    format!("{stem}.{extension}")
}

/// A new private folder per copy, so names never collide and no existing
/// path (or link) is written through.
fn write_marked(root: &Path, name: &str, bytes: &[u8]) -> io::Result<PathBuf> {
    let parent = opened_dir(root);
    secure_fs::create_private_dir_all(&parent)?;
    if !std::fs::symlink_metadata(&parent)?.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "opened-files is not a folder",
        ));
    }
    let folder = parent.join(uuid::Uuid::new_v4().to_string());
    secure_fs::create_private_dir(&folder)?;
    let path = folder.join(name);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    secure_fs::owner_only(&mut options);
    let mut file = options.open(&path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    if download_mark::supported() {
        download_mark::mark(&path)?;
    }
    Ok(path)
}

fn failed() -> HttpError {
    HttpError::public(500, "open_copy_failed", "The file could not be prepared.")
}
