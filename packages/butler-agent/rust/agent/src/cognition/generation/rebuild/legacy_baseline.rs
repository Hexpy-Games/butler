//! First rebuild on a pre-generation DATA root: adopt the legacy memory as an
//! active `legacy` baseline generation so the rebuild has a predecessor.

use super::*;

pub(super) async fn ensure(
    data_root: &Path,
    memory_root: &Path,
    canonical: &Path,
    lock: &Path,
    coordinator: &CognitionWriteCoordinator,
    cancellation: &CancellationToken,
    now: &str,
) -> CognitionResult<()> {
    let descriptor = memory_root.join("active-generation.json");
    if descriptor.exists() {
        return validate_active_descriptor(data_root, &descriptor);
    }
    let first = inventory::read(data_root, canonical, now, cancellation)?;
    let lease = coordinator
        .acquire(
            CognitionWriteAcquire {
                lock_path: lock.to_owned(),
                purpose: Some("cutover".into()),
                deadline_at_epoch_ms: None,
                cancellation: Some(cancellation.clone()),
            },
            CognitionWaitClass::Background,
        )
        .await
        .map_err(gate_error)?
        .ok_or_else(|| error("memory_write_busy"))?;
    let result = (|| {
        lease
            .assert_for_path(lock)
            .map_err(|_| error("memory_write_busy"))?;
        if descriptor.exists() {
            return validate_active_descriptor(data_root, &descriptor);
        }
        let second = inventory::read(data_root, canonical, now, cancellation)?;
        if second.hash != first.hash || second.canonical_revision != first.canonical_revision {
            return Err(error("memory_source_changed"));
        }
        let generations = memory_root.join("generations");
        durable::create_dir(&generations)?;
        let mut reusable = None;
        for entry in fs::read_dir(&generations).map_err(io_error)? {
            let path = entry.map_err(io_error)?.path();
            let manifest = path.join("manifest.json");
            if !manifest.is_file() {
                continue;
            }
            ensure_data_authority(data_root, &[&path, &manifest])?;
            let value: Value = serde_json::from_slice(&fs::read(&manifest).map_err(io_error)?)
                .map_err(|_| error("memory_generation_unavailable"))?;
            if value["format"] == "legacy"
                && value["initialization_origin"] == "legacy"
                && value["state"] == "active"
                && value["source_inventory_hash"] == first.hash
            {
                let id = value["generation_id"]
                    .as_str()
                    .ok_or_else(|| error("memory_generation_unavailable"))?;
                if path.file_name().and_then(|name| name.to_str()) != Some(id) || reusable.is_some()
                {
                    return Err(error("memory_generation_recovery_required"));
                }
                reusable = Some(id.to_owned());
            }
        }
        let generation_id = if let Some(id) = reusable {
            id
        } else {
            let id = uuid::Uuid::new_v4().to_string();
            let root = generations.join(&id);
            ensure_data_authority(data_root, &[&root])?;
            durable::create_dir(&root)?;
            let legacy_hash = crate::json::stringify(&json!(["legacy-baseline", id, first.hash]))
                .map_err(|_| error("memory_inventory_incomplete"))?;
            durable::write_json(
                &root.join("manifest.json"),
                &json!({
                    "schema":"butler.memory-generation.v2", "generation_id":id,
                    "format":"legacy", "state":"active", "initialization_origin":"legacy",
                    "schema_version":null, "extraction_version":null, "ranking_version":null,
                    "embedding":null, "unicode_version":null, "icu_version":null,
                    "canonical_snapshot_id":format!("{:x}",Sha256::digest(legacy_hash.as_bytes())),
                    "canonical_snapshot_path":null, "source_inventory_hash":first.hash,
                    "registered_source_count":0, "unaccounted_source_count":first.source_count,
                    "required_acceptance_passed":false,
                }),
            )?;
            id
        };
        ensure_data_authority(data_root, &[&descriptor])?;
        durable::write_json(
            &descriptor,
            &json!({
                "schema":"butler.memory-active-generation.v2", "generation_id":generation_id,
                "previous_generation_id":null, "activated_at":now, "projection_mode":"paused",
            }),
        )
    })();
    let released = lease
        .release(result.is_ok())
        .map_err(|_| error("memory_write_busy"));
    match (result, released) {
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
        (Ok(()), Ok(())) => Ok(()),
    }
}

fn validate_active_descriptor(data_root: &Path, path: &Path) -> CognitionResult<()> {
    ensure_data_authority(data_root, &[path])?;
    let descriptor: Value = serde_json::from_slice(
        &fs::read(path).map_err(|_| error("memory_generation_unavailable"))?,
    )
    .map_err(|_| error("memory_generation_unavailable"))?;
    if descriptor["schema"] != "butler.memory-active-generation.v2"
        || descriptor["generation_id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .is_none()
    {
        return Err(error("memory_generation_unavailable"));
    }
    Ok(())
}
