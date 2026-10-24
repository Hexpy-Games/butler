//! `POST /internal/opened-files`: a stored file the user chose to open in
//! another app. The App names the file by id only; this side checks the
//! type, writes a copy under the data folder's temporary files and marks it
//! as downloaded from the internet, then answers the copy's path for the App
//! to open. The copies are removed when the gateway starts and stops.
mod kind;

use std::{
    io::{self, Write},
    path::{Path, PathBuf},
    sync::Arc,
};

use serde::Deserialize;
use serde_json::json;

use super::{
    Body, Client, HttpError, HttpState, Method, Request, Response, StatusCode, json,
    read_body_with_limit,
};
use crate::gateway::protocol::{APP_PROTOCOL_VERSION, ApiEnvelope};
use butler_platform::{data_paths, download_mark, secure_fs};

const OPENED_DIR: &str = "opened-files";

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
    if !download_mark::supported() {
        return Err(HttpError::public(
            501,
            "open_unsupported",
            "This system cannot mark a file as downloaded, so it is not opened.",
        ));
    }
    let bytes = read_body_with_limit(request.into_body(), 4096).await?;
    let input: OpenRequest = serde_json::from_slice(&bytes).map_err(|_| {
        HttpError::public(400, "open_request_invalid", "Request must be {file_id}.")
    })?;
    let download = state
        .application
        .download_message_file(input.file_id)
        .await?;
    let kind = kind::verify(&download.file.safe_name, &download.bytes).map_err(refused)?;
    let name = copy_name(&download.file.safe_name, kind.extension());
    let path = tokio::task::spawn_blocking(move || write_marked(&root, &name, &download.bytes))
        .await
        .map_err(|_| failed())?
        .map_err(|_| failed())?;
    json(
        StatusCode::CREATED,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data: json!({ "path": path }),
        },
    )
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
    download_mark::mark(&path)?;
    Ok(path)
}

fn refused(refusal: kind::Refusal) -> HttpError {
    match refusal {
        kind::Refusal::NotAllowed => HttpError::public(
            415,
            "open_type_not_allowed",
            "This file type does not open in another app.",
        ),
        kind::Refusal::Mismatch => HttpError::public(
            415,
            "open_type_mismatch",
            "The file's content does not match its name.",
        ),
    }
}

fn failed() -> HttpError {
    HttpError::public(500, "open_copy_failed", "The file could not be prepared.")
}
