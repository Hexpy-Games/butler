//! Refresh a building candidate's immutable source snapshot before build work.

use std::{
    fs::{self, File},
    path::{Path, PathBuf},
    sync::Arc,
    time::SystemTime,
};

use rusqlite::{Connection, OpenFlags, params};
use tokio_util::sync::CancellationToken;

use super::{error, hash_file, inventory, io_error, snapshot_id, typed_snapshot};
use crate::cognition::CognitionCode;
use crate::{
    cognition::{
        CognitionPathEnvironment, CognitionResult, MemoryGenerationTarget, ensure_data_authority,
        generation::{
            initialize::durable,
            manifest::{
                ACTIVE_DESCRIPTOR_SCHEMA, CanonicalSnapshot, DescriptorView, GenerationManifest,
                GenerationState,
            },
            qualification_witness::{CandidateWitness, LiveWitness},
        },
        resolve_generation,
    },
    coordination::{CognitionWaitClass, CognitionWriteAcquire, CognitionWriteCoordinator},
};

/// The live inventory a refreshed snapshot must reproduce exactly.
struct ExpectedSnapshot {
    hash: String,
    inventory: inventory::MemorySourceInventory,
    canonical_revision: i64,
}

impl ExpectedSnapshot {
    fn matches(&self, actual: &inventory::SourceInventory) -> bool {
        actual.hash == self.hash
            && actual.inventory == self.inventory
            && actual.canonical_revision == self.canonical_revision
    }
}

struct Snapshot {
    path: PathBuf,
    sha256: String,
    bytes: u64,
    duration_ms: u64,
}

pub async fn refresh_if_changed(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    generation_id: &str,
    now: &str,
    cancellation: &CancellationToken,
) -> CognitionResult<Option<String>> {
    if cancellation.is_cancelled() {
        return Err(error(CognitionCode::MemoryOperationAborted));
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
    let initial = read_manifest(&manifest_path)?;
    let old_snapshot_id = required(initial.canonical_snapshot_id.as_deref())?.to_owned();
    let old_inventory_hash = required(initial.source_inventory_hash.as_deref())?.to_owned();
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
    .map_err(|source| error(CognitionCode::MemoryInventoryIncomplete).with_source(source))??;
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
    let expected = ExpectedSnapshot {
        hash: live.hash.clone(),
        inventory: live.inventory.clone(),
        canonical_revision: live.canonical_revision,
    };
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
    .map_err(|source| error(CognitionCode::MemorySnapshotChanged).with_source(source))??;
    live_witness.assert_current()?;
    live_witness.assert_public_revision(live.canonical_revision)?;
    candidate.assert_current(&old_handle).await?;
    if cancellation.is_cancelled() {
        return Err(error(CognitionCode::MemoryOperationAborted));
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
        .map_err(|source| error(CognitionCode::MemoryWriteBusy).with_source(source))?
        .ok_or_else(|| error(CognitionCode::MemoryWriteBusy))?;
    let result = async {
        lease
            .assert_for_path(&lock)
            .map_err(|source| error(CognitionCode::MemoryWriteBusy).with_source(source))?;
        if cancellation.is_cancelled() {
            return Err(error(CognitionCode::MemoryOperationAborted));
        }
        live_witness.assert_current()?;
        live_witness.assert_public_revision(live.canonical_revision)?;
        candidate.assert_current(&old_handle).await?;
        assert_building_inactive(
            data_root,
            &manifest_path,
            &active_path,
            generation_id,
            &old_snapshot_id,
            &old_inventory_hash,
        )?;
        let mut current = read_manifest(&manifest_path)?;
        current.state = Some(GenerationState::Building);
        current.canonical_snapshot_id = Some(new_snapshot_id.clone());
        current.canonical_snapshot_path = Some(format!("{name}/runtime/conversation-store.sqlite"));
        current.canonical_snapshot = Some(CanonicalSnapshot {
            file_sha256: snapshot.sha256.clone(),
            bytes: snapshot.bytes,
            duration_ms: snapshot.duration_ms,
            canonical_revision: live.canonical_revision,
            base_snapshot_id: Some(
                initial
                    .canonical_snapshot
                    .as_ref()
                    .and_then(|previous| previous.base_snapshot_id.clone())
                    .unwrap_or_else(|| old_snapshot_id.clone()),
            ),
            delta_from_snapshot_id: Some(old_snapshot_id.clone()),
        });
        current.source_inventory_hash = Some(live.hash.clone());
        current.registered_source_count = Some(0);
        current.unaccounted_source_count = Some(live.source_count as u64);
        current.required_acceptance_passed = Some(false);
        current.readiness = None;
        ensure_data_authority(data_root, &[&manifest_path, &snapshot.path, &lock])?;
        durable::write_json(&manifest_path, &current)?;
        Ok(new_snapshot_id.clone())
    }
    .await;
    let released = lease
        .release(result.is_ok())
        .map_err(|source| error(CognitionCode::MemoryWriteBusy).with_source(source));
    match (result, released) {
        (Err(error), _) | (Ok(_), Err(error)) => Err(error),
        (Ok(value), Ok(())) => Ok(Some(value)),
    }
}

fn stage_snapshot(
    data_root: &Path,
    generation_root: &Path,
    name: &str,
    staged: &Path,
    as_of: &str,
    expected: &ExpectedSnapshot,
    cancellation: &CancellationToken,
) -> CognitionResult<Snapshot> {
    let published = generation_root.join(name);
    ensure_data_authority(data_root, &[generation_root, &published, staged])?;
    let started = SystemTime::now();
    if !published.exists() {
        if staged.exists() {
            return Err(error(CognitionCode::MemorySnapshotChanged));
        }
        let staged_snapshot = staged.join("runtime/conversation-store.sqlite");
        let result = (|| {
            durable::create_dir(
                staged_snapshot
                    .parent()
                    .ok_or_else(|| error(CognitionCode::MemorySnapshotChanged))?,
            )?;
            let source = data_root.join("runtime/conversation-store.sqlite");
            ensure_data_authority(data_root, &[&source, &staged_snapshot])?;
            let db = Connection::open_with_flags(&source, OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(|source| {
                    error(CognitionCode::MemorySnapshotChanged).with_source(source)
                })?;
            db.execute(
                "VACUUM INTO ?1",
                params![
                    staged_snapshot
                        .to_str()
                        .ok_or_else(|| error(CognitionCode::MemorySnapshotChanged))?
                ],
            )
            .map_err(|source| error(CognitionCode::MemorySnapshotChanged).with_source(source))?;
            db.close().map_err(|(_, source)| {
                error(CognitionCode::MemorySnapshotChanged).with_source(source)
            })?;
            File::open(&staged_snapshot)
                .and_then(|file| file.sync_all())
                .map_err(io_error)?;
            if let Some(directory) = staged_snapshot.parent() {
                File::open(directory)
                    .and_then(|dir| dir.sync_all())
                    .map_err(io_error)?;
            }
            if cancellation.is_cancelled() {
                return Err(error(CognitionCode::MemoryOperationAborted));
            }
            typed_snapshot::copy_typed_sources(data_root, staged)?;
            let copied = inventory::read(staged, &staged_snapshot, as_of, cancellation)?;
            if !expected.matches(&copied) {
                return Err(error(CognitionCode::MemorySnapshotChanged));
            }
            durable::write_json(
                &staged.join("memory-source-inventory.json"),
                &copied.inventory,
            )?;
            File::open(staged)
                .and_then(|dir| dir.sync_all())
                .map_err(io_error)?;
            if published.exists() {
                return Err(error(CognitionCode::MemorySnapshotChanged));
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
    if !expected.matches(&actual) {
        return Err(error(CognitionCode::MemorySnapshotChanged));
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
    let manifest = read_manifest(manifest_path)?;
    let active: DescriptorView =
        serde_json::from_slice(&fs::read(active_path).map_err(|source| {
            error(CognitionCode::MemoryGenerationUnavailable).with_source(source)
        })?)
        .map_err(|source| error(CognitionCode::MemoryGenerationUnavailable).with_source(source))?;
    if !manifest.is_for(generation_id)
        || !manifest.is_v2_in(GenerationState::Building)
        || manifest.canonical_snapshot_id.as_deref() != Some(expected_snapshot_id)
        || manifest.source_inventory_hash.as_deref() != Some(expected_hash)
        || active.schema.as_deref() != Some(ACTIVE_DESCRIPTOR_SCHEMA)
        || active.generation_id.as_deref() == Some(generation_id)
    {
        return Err(error(CognitionCode::MemorySnapshotChanged));
    }
    Ok(())
}

fn read_manifest(path: &Path) -> CognitionResult<GenerationManifest> {
    GenerationManifest::read(path, CognitionCode::MemoryGenerationUnavailable)
}

fn required(value: Option<&str>) -> CognitionResult<&str> {
    value.ok_or_else(|| error(CognitionCode::MemoryGenerationChanged))
}
