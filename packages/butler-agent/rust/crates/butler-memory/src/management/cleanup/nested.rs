//! Detached snapshots and qualification evidence have no serving reader.
use super::{CleanupItem, files, plan::contains, safety};
use std::{fs, io, path::Path};
use tokio_util::sync::CancellationToken;

pub(super) fn analyze(
    memory: &Path,
    active: &str,
    descriptor: &[u8],
    manifest: &[u8],
    token: &CancellationToken,
) -> io::Result<Vec<CleanupItem>> {
    let mut items = Vec::new();
    let root = memory.join("generations").join(active);
    for entry in fs::read_dir(root)? {
        safety::cancelled(token)?;
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !artifact_name(&name) {
            continue;
        }
        let referenced = contains(descriptor, &name) || contains(manifest, &name);
        let measured = files(&entry.path(), token)?;
        items.push(CleanupItem {
            name: format!("generations/{active}/{name}"),
            allocated_bytes: measured.bytes,
            outcome: "kept".into(),
            reason: if referenced {
                "descriptor_or_manifest_reference"
            } else {
                "unreferenced_artifact"
            }
            .into(),
        });
    }
    Ok(items)
}

pub(super) fn artifact_name(name: &str) -> bool {
    name == "source-snapshot"
        || name == "qualification"
        || name.strip_prefix("source-snapshot-").is_some_and(|suffix| {
            !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
}

pub(super) fn validate_name(name: &str) -> io::Result<()> {
    let mut parts = name.split('/');
    if parts.next() != Some("generations") {
        return Err(io::Error::other("Unknown trash provenance"));
    }
    super::validate_id(
        parts
            .next()
            .ok_or_else(|| io::Error::other("Unknown trash provenance"))?,
    )?;
    if parts.next().is_some_and(|name| !artifact_name(name)) || parts.next().is_some() {
        return Err(io::Error::other("Unknown trash provenance"));
    }
    Ok(())
}
