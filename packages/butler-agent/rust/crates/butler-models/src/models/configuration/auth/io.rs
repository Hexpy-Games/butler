//! Bounded OAuth response and profile filesystem I/O.

use std::path::Path;

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

pub(super) async fn write_mode_600(path: &Path, bytes: &[u8]) -> Result<(), AuthError> {
    #[cfg(unix)]
    {
        use std::{io::Write, os::unix::fs::OpenOptionsExt};
        let path = path.to_owned();
        let bytes = bytes.to_owned();
        tokio::task::spawn_blocking(move || {
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .open(path)?;
            file.write_all(&bytes)
        })
        .await
        .map_err(|source| write_error().with_source(source))?
        .map_err(|source| write_error().with_source(source))
    }
    #[cfg(not(unix))]
    tokio::fs::write(path, bytes)
        .await
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
