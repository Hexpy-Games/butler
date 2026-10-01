//! Read the selected service's in-memory progress without initializing DATA.
use crate::host::ResolvedInstallation;
use serde_json::Value;
use std::path::Path;

pub(super) async fn read(root: &Path, installation: &ResolvedInstallation) -> Value {
    if let Some(progress) = super::gateway::memory_status(root, installation).await
        && progress.is_object()
    {
        return progress;
    }
    let root = root.to_owned();
    tokio::task::spawn_blocking(move || {
        crate::host::embedding::worker::assets::cached_status(&root)
    })
    .await
    .unwrap_or_else(|_| serde_json::json!({"state":"failed", "reason":"embed_asset_unavailable", "bytes_done":0, "bytes_total":0}))
}
pub(super) fn line(value: &Value) -> String {
    let state = value["state"].as_str().unwrap_or("unknown");
    let done = value["bytes_done"].as_u64().unwrap_or(0);
    let total = value["bytes_total"].as_u64().unwrap_or(0);
    let reason = value["reason"].as_str().unwrap_or("");
    format!(
        "Memory model: {state} ({:.0} / {:.0} MB) {reason}",
        done as f64 / 1_000_000.0,
        total as f64 / 1_000_000.0
    )
}
