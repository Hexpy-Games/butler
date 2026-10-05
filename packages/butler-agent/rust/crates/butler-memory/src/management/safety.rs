use crate::cognition::{CognitionPathEnvironment, ensure_data_authority};
use std::{io, path::Path};

pub(super) fn validate(root: &Path, paths: &CognitionPathEnvironment) -> io::Result<()> {
    if !root.join("agent-runtime/btcc.sqlite").exists()
        && root.join("app-server/butler-client.sqlite").exists()
    {
        return Err(io::Error::other("Legacy data folder is unsupported"));
    }
    ensure_data_authority(
        root,
        &[
            &paths.memory_root(root),
            &paths.cognition_root(root),
            &paths.consolidation_lock(root),
            &paths.memory_root(root).join("management"),
            &root.join("cognition/profile"),
        ],
    )
    .map_err(io::Error::other)
}

pub(super) fn cancelled(token: &tokio_util::sync::CancellationToken) -> io::Result<()> {
    if token.is_cancelled() {
        Err(io::Error::new(io::ErrorKind::Interrupted, "Cancelled"))
    } else {
        Ok(())
    }
}

pub(super) fn active(
    root: &Path,
    paths: &CognitionPathEnvironment,
) -> io::Result<crate::cognition::MemoryGenerationHandle> {
    let memory = paths.memory_root(root);
    let descriptor = memory.join("active-generation.json");
    ensure_data_authority(root, &[&descriptor, &memory.join("generations")])
        .map_err(io::Error::other)?;
    let view: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&descriptor)?).map_err(io::Error::other)?;
    let id = view
        .get("generation_id")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| io::Error::other("Generation unavailable"))?;
    if !uuid::Uuid::parse_str(id).is_ok_and(|value| value.to_string() == id) {
        return Err(io::Error::other("Generation unavailable"));
    }
    ensure_data_authority(
        root,
        &[&memory.join("generations").join(id).join("manifest.json")],
    )
    .map_err(io::Error::other)?;
    crate::cognition::resolve_active_generation(root, paths).map_err(io::Error::other)
}
