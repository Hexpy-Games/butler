use super::{CleanupItem, files, safety};
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
    let generations = memory.join("generations");
    let references = manifest_references(&generations);
    for entry in fs::read_dir(&generations)? {
        safety::cancelled(token)?;
        let entry = entry?;
        let id = entry.file_name().to_string_lossy().into_owned();

        let path = entry.path();
        let bytes = match files(&path, token) {
            Ok(measured) => measured.bytes,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => return Err(error),
            Err(_) => {
                items.push(CleanupItem {
                    name: format!("generations/{id}"),
                    allocated_bytes: None,
                    outcome: "kept".into(),
                    reason: "unreadable_or_linked_artifact".into(),
                });
                continue;
            }
        };
        let empty = entry.file_type()?.is_dir() && fs::read_dir(&path)?.next().is_none();
        let referenced = contains(descriptor, &id)
            || contains(manifest, &id)
            || references
                .as_ref()
                .is_some_and(|values| values.iter().any(|value| contains(value, &id)));
        let reason = if id == active {
            "active_generation"
        } else if references.is_none() {
            "manifest_reference_inventory_unavailable"
        } else if referenced {
            "descriptor_or_manifest_reference"
        } else if empty && super::validate_id(&id).is_ok() {
            "unpublished_empty_generation"
        } else {
            "generation_candidate_or_rollback_reader"
        };
        items.push(CleanupItem {
            name: format!("generations/{id}"),
            allocated_bytes: bytes,
            outcome: "kept".into(),
            reason: reason.into(),
        });
        // Nested snapshots/evidence are counted in their generation, never twice.
    }
    for (name, reason) in [
        ("db", "project_capsule_legacy_graph_reader"),
        ("hot", "legacy_prompt_and_recovery_reader"),
        ("conversations", "legacy_source_authority_reader"),
    ] {
        if fs::symlink_metadata(memory.join(name))
            .map_or_else(|error| error.kind() != io::ErrorKind::NotFound, |_| true)
        {
            items.push(retained_artifact(memory, name, reason, token)?);
        }
    }
    items.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(items)
}

fn contains(bytes: &[u8], id: &str) -> bool {
    bytes
        .windows(id.len())
        .any(|window| window == id.as_bytes())
}

fn manifest_references(generations: &Path) -> Option<Vec<Vec<u8>>> {
    let mut references = Vec::new();
    for entry in fs::read_dir(generations).ok()? {
        let path = entry.ok()?.path().join("manifest.json");
        crate::cognition::ensure_data_authority(generations, &[&path]).ok()?;
        match fs::read(path) {
            Ok(bytes) => {
                serde_json::from_slice::<serde_json::Value>(&bytes).ok()?;
                references.push(bytes);
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(_) => return None,
        }
    }
    Some(references)
}

fn retained_artifact(
    memory: &Path,
    name: &str,
    reason: &str,
    token: &CancellationToken,
) -> io::Result<CleanupItem> {
    let (allocated_bytes, reason) = match files(&memory.join(name), token) {
        Ok(measured) => (measured.bytes, reason),
        Err(error) if error.kind() == io::ErrorKind::Interrupted => return Err(error),
        Err(_) => (None, "unreadable_or_linked_artifact"),
    };
    Ok(CleanupItem {
        name: name.into(),
        allocated_bytes,
        outcome: "kept".into(),
        reason: reason.into(),
    })
}
