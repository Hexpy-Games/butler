//! One-shot start request for CLI, App and service-manager restarts.
use super::{Result, error};
use std::path::Path;
const REQUEST: &str = "state/plugin-safe-mode-once.json";
pub(crate) async fn request(data: &Path) -> Result<()> {
    if !std::env::args_os().any(|s| s == "--safe-mode") {
        return Ok(());
    }
    let data = data.to_owned();
    tokio::task::spawn_blocking(move || {
        butler_core::configuration::write_json_atomic(
            &data.join(REQUEST),
            &serde_json::json!({"safe_mode":true}),
        )
        .map_err(|_| error("safe_mode_request_failed"))
    })
    .await
    .map_err(|_| error("safe_mode_request_failed"))?
}
pub(super) fn take(data: &Path) -> Result<bool> {
    let path = data.join(REQUEST);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err(error("safe_mode_request_failed")),
    };
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| error("safe_mode_request_failed"))?;
    std::fs::remove_file(path).map_err(|_| error("safe_mode_request_failed"))?;
    Ok(value.get("safe_mode") == Some(&serde_json::Value::Bool(true)))
}
