//! Refresh a building candidate's immutable source snapshot before build work.

use std::{
    fs::{self, File},
    path::{Path, PathBuf},
    sync::Arc,
    time::SystemTime,
};

use rusqlite::{Connection, OpenFlags, params};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::{error, hash_file, inventory, io_error, snapshot_id, typed_snapshot};
use crate::{
    cognition::{
        CognitionPathEnvironment, CognitionResult, MemoryGenerationTarget, ensure_data_authority,
        generation::{
            initialize::durable,
            qualification_witness::{CandidateWitness, LiveWitness},
        },
        resolve_generation,
    },
    coordination::{CognitionWaitClass, CognitionWriteAcquire, CognitionWriteCoordinator},
};

struct Snapshot {
    path: PathBuf,
    sha256: String,
    bytes: u64,
    duration_ms: u64,
}

pub(crate) async fn refresh_if_changed(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    generation_id: &str,
    now: &str,
    cancellation: &CancellationToken,
) -> CognitionResult<Option<String>> {
    if cancellation.is_cancelled() {
        return Err(error("memory_operation_aborted"));
    }
    let memory_root = environment.memory_root(data_root);
    let generation_root = memory_root.join("generations").join(generation_id);
    let manifest_path = generation_root.join("manifest.json");
    let active_path = memory_root.join("active-generation.json");
    let canonical = data_root.join("runtime/conversation-store.sqlite");
    let lock = environment.consolidation_lock(data_root);
    ensure_data_authority(
        data_root,
        &[
            &memory_root,
            &generation_root,
            &manifest_path,
            &active_path,
            &canonical,
            &lock,
        ],
    )?;
    let initial = read_json(&manifest_path)?;
    let old_snapshot_id = field(&initial, "canonical_snapshot_id")?.to_owned();
    let old_inventory_hash = field(&initial, "source_inventory_hash")?.to_owned();
    let target = MemoryGenerationTarget::Rebuild {
        generation_id: generation_id.to_owned(),
        canonical_snapshot_id: old_snapshot_id.clone(),
    };
    let old_handle = resolve_generation(data_root, environment, &target)?;
    let live_witness = LiveWitness::open(data_root)?;
    let (data, canonical_copy, as_of, token) = (
        data_root.to_owned(),
        canonical.clone(),
        now.to_owned(),
        cancellation.clone(),
    );
    let live = tokio::task::spawn_blocking(move || {
        inventory::read(&data, &canonical_copy, &as_of, &token)
    })
    .await
    .map_err(|_| error("memory_inventory_incomplete"))??;
    live_witness.assert_current()?;
    live_witness.assert_public_revision(live.canonical_revision)?;
    if live.hash == old_inventory_hash {
        return Ok(None);
    }
    assert_building_inactive(
        data_root,
        &manifest_path,
        &active_path,
        generation_id,
        &old_snapshot_id,
        &old_inventory_hash,
    )?;
    let candidate = CandidateWitness::open(data_root, &old_handle).await?;
    candidate.assert_current(&old_handle).await?;
    let name = format!("source-snapshot-{}", &live.hash[..16]);
    let published = generation_root.join(&name);
    let staged = generation_root.join(format!(".refresh-{}", uuid::Uuid::new_v4()));
    ensure_data_authority(data_root, &[&published, &staged])?;
    let stage_data = data_root.to_owned();
    let stage_generation = generation_root.clone();
    let stage_name = name.clone();
    let stage_as_of = now.to_owned();
    let stage_token = cancellation.clone();
    let expected = (
        live.hash.clone(),
        live.value.clone(),
        live.canonical_revision,
    );
    let snapshot = tokio::task::spawn_blocking(move || {
        stage_snapshot(
            &stage_data,
            &stage_generation,
            &stage_name,
            &staged,
            &stage_as_of,
            &expected,
            &stage_token,
        )
    })
    .await
    .map_err(|_| error("memory_snapshot_changed"))??;
    live_witness.assert_current()?;
    live_witness.assert_public_revision(live.canonical_revision)?;
    candidate.assert_current(&old_handle).await?;
    if cancellation.is_cancelled() {
        return Err(error("memory_operation_aborted"));
    }
    let new_snapshot_id = snapshot_id(generation_id, &live.hash)?;
    let lease = coordinator
        .acquire(
            CognitionWriteAcquire {
                lock_path: lock.clone(),
                purpose: Some("rebuild_snapshot".into()),
                deadline_at_epoch_ms: None,
                cancellation: Some(cancellation.clone()),
            },
            CognitionWaitClass::Background,
        )
        .await
        .map_err(|_| error("memory_write_busy"))?
        .ok_or_else(|| error("memory_write_busy"))?;
    let result = async {
        lease.assert_for_path(&lock).map_err(|_| error("memory_write_busy"))?;
        if cancellation.is_cancelled() { return Err(error("memory_operation_aborted")); }
        live_witness.assert_current()?;
        live_witness.assert_public_revision(live.canonical_revision)?;
        candidate.assert_current(&old_handle).await?;
        assert_building_inactive(data_root, &manifest_path, &active_path, generation_id, &old_snapshot_id, &old_inventory_hash)?;
        let mut current = read_json(&manifest_path)?;
        current["state"] = json!("building");
        current["canonical_snapshot_id"] = json!(new_snapshot_id);
        current["canonical_snapshot_path"] = json!(format!("{name}/runtime/conversation-store.sqlite"));
        current["canonical_snapshot"] = json!({
            "file_sha256":snapshot.sha256,"bytes":snapshot.bytes,"duration_ms":snapshot.duration_ms,
            "canonical_revision":live.canonical_revision,
            "base_snapshot_id":initial["canonical_snapshot"]["base_snapshot_id"].as_str().unwrap_or(&old_snapshot_id),
            "delta_from_snapshot_id":old_snapshot_id,
        });
        current["source_inventory_hash"] = json!(live.hash);
        current["registered_source_count"] = json!(0);
        current["unaccounted_source_count"] = json!(live.source_count);
        current["required_acceptance_passed"] = json!(false);
        current.as_object_mut().ok_or_else(|| error("memory_generation_changed"))?.remove("readiness");
        ensure_data_authority(data_root, &[&manifest_path, &snapshot.path, &lock])?;
        durable::write_json(&manifest_path, &current)?;
        Ok(new_snapshot_id.clone())
    }.await;
    let released = lease
        .release(result.is_ok())
        .map_err(|_| error("memory_write_busy"));
    match (result, released) {
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
        (Ok(value), Ok(())) => Ok(Some(value)),
    }
}

fn stage_snapshot(
    data_root: &Path,
    generation_root: &Path,
    name: &str,
    staged: &Path,
    as_of: &str,
    expected: &(String, Value, i64),
    cancellation: &CancellationToken,
) -> CognitionResult<Snapshot> {
    let published = generation_root.join(name);
    ensure_data_authority(data_root, &[generation_root, &published, staged])?;
    let started = SystemTime::now();
    if !published.exists() {
        if staged.exists() {
            return Err(error("memory_snapshot_changed"));
        }
        let staged_snapshot = staged.join("runtime/conversation-store.sqlite");
        let result = (|| {
            durable::create_dir(
                staged_snapshot
                    .parent()
                    .ok_or_else(|| error("memory_snapshot_changed"))?,
            )?;
            let source = data_root.join("runtime/conversation-store.sqlite");
            ensure_data_authority(data_root, &[&source, &staged_snapshot])?;
            let db = Connection::open_with_flags(&source, OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(|_| error("memory_snapshot_changed"))?;
            db.execute(
                "VACUUM INTO ?1",
                params![
                    staged_snapshot
                        .to_str()
                        .ok_or_else(|| error("memory_snapshot_changed"))?
                ],
            )
            .map_err(|_| error("memory_snapshot_changed"))?;
            db.close().map_err(|_| error("memory_snapshot_changed"))?;
            File::open(&staged_snapshot)
                .and_then(|file| file.sync_all())
                .map_err(io_error)?;
            if let Some(directory) = staged_snapshot.parent() {
                File::open(directory)
                    .and_then(|dir| dir.sync_all())
                    .map_err(io_error)?;
            }
            if cancellation.is_cancelled() {
                return Err(error("memory_operation_aborted"));
            }
            typed_snapshot::copy_typed_sources(data_root, staged)?;
            let copied = inventory::read(staged, &staged_snapshot, as_of, cancellation)?;
            if (
                copied.hash.as_str(),
                &copied.value,
                copied.canonical_revision,
            ) != (expected.0.as_str(), &expected.1, expected.2)
            {
                return Err(error("memory_snapshot_changed"));
            }
            durable::write_json(&staged.join("memory-source-inventory.json"), &copied.value)?;
            File::open(staged)
                .and_then(|dir| dir.sync_all())
                .map_err(io_error)?;
            if published.exists() {
                return Err(error("memory_snapshot_changed"));
            }
            fs::rename(staged, &published).map_err(io_error)?;
            File::open(generation_root)
                .and_then(|dir| dir.sync_all())
                .map_err(io_error)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_dir_all(staged);
        }
        result?;
    }
    let canonical = published.join("runtime/conversation-store.sqlite");
    let actual = inventory::read(&published, &canonical, as_of, cancellation)?;
    if (
        actual.hash.as_str(),
        &actual.value,
        actual.canonical_revision,
    ) != (expected.0.as_str(), &expected.1, expected.2)
    {
        return Err(error("memory_snapshot_changed"));
    }
    let bytes = fs::metadata(&canonical).map_err(io_error)?.len();
    let sha256 = hash_file(&canonical)?;
    let duration_ms = u64::try_from(
        started
            .elapsed()
            .unwrap_or_default()
            .as_millis()
            .min(u128::from(u64::MAX)),
    )
    .unwrap_or(u64::MAX);
    Ok(Snapshot {
        path: published,
        sha256,
        bytes,
        duration_ms,
    })
}

fn assert_building_inactive(
    data_root: &Path,
    manifest_path: &Path,
    active_path: &Path,
    generation_id: &str,
    expected_snapshot_id: &str,
    expected_hash: &str,
) -> CognitionResult<()> {
    ensure_data_authority(data_root, &[manifest_path, active_path])?;
    let manifest = read_json(manifest_path)?;
    let active = read_json(active_path)?;
    if manifest["schema"] != "butler.memory-generation.v2"
        || manifest["generation_id"] != generation_id
        || manifest["format"] != "v2"
        || manifest["canonical_snapshot_id"] != expected_snapshot_id
        || manifest["source_inventory_hash"] != expected_hash
        || manifest["state"] != "building"
        || active["schema"] != "butler.memory-active-generation.v2"
        || active["generation_id"] == generation_id
    {
        return Err(error("memory_snapshot_changed"));
    }
    Ok(())
}

fn read_json(path: &Path) -> CognitionResult<Value> {
    serde_json::from_slice(&fs::read(path).map_err(|_| error("memory_generation_unavailable"))?)
        .map_err(|_| error("memory_generation_unavailable"))
}

fn field<'a>(value: &'a Value, name: &str) -> CognitionResult<&'a str> {
    value[name]
        .as_str()
        .ok_or_else(|| error("memory_generation_changed"))
}
