//! Bounded OAuth response and profile filesystem I/O.

use std::io::Write;
use std::path::Path;

use butler_platform::secure_fs;
use serde_json::{Map, Value};

use super::{AuthError, error};

pub(super) async fn read_json_object(path: &Path) -> Option<Map<String, Value>> {
    let bytes = tokio::fs::read(path).await.ok()?;
    // Lossy UTF-8 decoding matches the source's readFile(.., "utf8").
    serde_json::from_str::<Value>(&String::from_utf8_lossy(&bytes))
        .ok()?
        .as_object()
        .cloned()
}

/// Writes `bytes` to `path`, creating it as an owner-only file.
pub(super) async fn write_mode_600(path: &Path, bytes: &[u8]) -> Result<(), AuthError> {
    let path = path.to_owned();
    let bytes = bytes.to_owned();
    tokio::task::spawn_blocking(move || {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        let _ = secure_fs::owner_only(&mut options);
        let mut file = options.open(path)?;
        file.write_all(&bytes)
    })
    .await
    .map_err(|source| write_error().with_source(source))?
    .map_err(|source| write_error().with_source(source))
}

/// The response body as JSON; the error is the transport or decoding failure.
pub(super) async fn response_json(
    response: reqwest::Response,
) -> Result<Value, Box<dyn std::error::Error + Send + Sync>> {
    let bytes = response.bytes().await?;
    Ok(serde_json::from_slice(&bytes)?)
}

fn write_error() -> AuthError {
    error(
        "provider_auth_write_failed",
        "OpenAI auth profile could not be written.",
    )
}
