//! Refresh a building candidate's immutable source snapshot before build work.
//!
//! When the live sources no longer match the candidate's inventory, a new
//! `source-snapshot-<hash>` directory is staged beside the old one and the
//! manifest is repointed at it under the write gate. The old snapshot stays
//! as the delta base.

use std::{
    fs::{self, File},
    path::{Path, PathBuf},
    sync::Arc,
    time::SystemTime,
};

use tokio_util::sync::CancellationToken;

use super::{
    elapsed_ms, error, hash_file, inventory, io_error, snapshot_id, typed_snapshot, vacuum_snapshot,
};
use crate::cognition::CognitionCode;
use crate::{
    cognition::{
        CognitionPathEnvironment, CognitionResult, MemoryGenerationHandle, MemoryGenerationTarget,
        ensure_data_authority,
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
    coordination::{CognitionWriteCoordinator, CognitionWriteLease},
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

/// A published snapshot directory and its canonical store facts.
struct Snapshot {
    name: String,
    path: PathBuf,
    sha256: String,
    bytes: u64,
    duration_ms: u64,
}

/// Paths of the candidate being refreshed.
struct CandidatePaths {
    generation_root: PathBuf,
    manifest: PathBuf,
    active: PathBuf,
    lock: PathBuf,
}

/// The candidate as observed before refreshing.
struct Observed {
    manifest: GenerationManifest,
    snapshot_id: String,
    inventory_hash: String,
    handle: MemoryGenerationHandle,
}

/// Restages the candidate's snapshot when the live sources changed. Returns
/// the new snapshot id, or `None` when the candidate is already current.
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
    let paths = candidate_paths(data_root, environment, generation_id)?;
    let observed = observe(data_root, environment, &paths, generation_id)?;
    let live_witness = LiveWitness::open(data_root)?;
    let live = read_live_inventory(data_root, now, cancellation).await?;
    live_witness.assert_current()?;
    live_witness.assert_public_revision(live.canonical_revision)?;
    if live.hash == observed.inventory_hash {
        return Ok(None);
    }
    assert_building_inactive(data_root, &paths, generation_id, &observed)?;
    let candidate = CandidateWitness::open(data_root, &observed.handle).await?;
    candidate.assert_current(&observed.handle).await?;
    let snapshot = stage_in_background(data_root, &paths, &live, now, cancellation).await?;
    live_witness.assert_current()?;
    live_witness.assert_public_revision(live.canonical_revision)?;
    candidate.assert_current(&observed.handle).await?;
    if cancellation.is_cancelled() {
        return Err(error(CognitionCode::MemoryOperationAborted));
    }
    let new_snapshot_id = snapshot_id(generation_id, &live.hash)?;
    let lease = crate::cognition::generation::stage::acquire(
        &coordinator,
        &paths.lock,
        "rebuild_snapshot",
        cancellation,
    )
    .await?;
    let commit = Repoint {
        data_root,
        paths: &paths,
        generation_id,
        observed: &observed,
        live: &live,
        snapshot: &snapshot,
        new_snapshot_id: &new_snapshot_id,
        witnesses: (&live_witness, &candidate),
    };
    let result = commit.run(&lease, cancellation).await;
    crate::cognition::generation::stage::finish(lease, result).map(|()| Some(new_snapshot_id))
}

fn candidate_paths(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    generation_id: &str,
) -> CognitionResult<CandidatePaths> {
    let memory_root = environment.memory_root(data_root);
    let generation_root = memory_root.join("generations").join(generation_id);
    let paths = CandidatePaths {
        manifest: generation_root.join("manifest.json"),
        active: memory_root.join("active-generation.json"),
        lock: environment.consolidation_lock(data_root),
        generation_root,
    };
    ensure_data_authority(
        data_root,
        &[
            &memory_root,
            &paths.generation_root,
            &paths.manifest,
            &paths.active,
            &data_root.join("runtime/conversation-store.sqlite"),
            &paths.lock,
        ],
    )?;
    Ok(paths)
}

fn observe(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    paths: &CandidatePaths,
    generation_id: &str,
) -> CognitionResult<Observed> {
    let manifest = read_manifest(&paths.manifest)?;
    let snapshot_id = required(manifest.canonical_snapshot_id.as_deref())?.to_owned();
    let inventory_hash = required(manifest.source_inventory_hash.as_deref())?.to_owned();
    let target = MemoryGenerationTarget::Rebuild {
        generation_id: generation_id.to_owned(),
        canonical_snapshot_id: snapshot_id.clone(),
    };
    let handle = resolve_generation(data_root, environment, &target)?;
    Ok(Observed {
        manifest,
        snapshot_id,
        inventory_hash,
        handle,
    })
}

async fn read_live_inventory(
    data_root: &Path,
    now: &str,
    cancellation: &CancellationToken,
) -> CognitionResult<inventory::SourceInventory> {
    let (data, as_of, token) = (data_root.to_owned(), now.to_owned(), cancellation.clone());
    tokio::task::spawn_blocking(move || {
        let canonical = data.join("runtime/conversation-store.sqlite");
        inventory::read(&data, &canonical, &as_of, &token)
    })
    .await
    .map_err(|source| error(CognitionCode::MemoryInventoryIncomplete).with_source(source))?
}

async fn stage_in_background(
    data_root: &Path,
    paths: &CandidatePaths,
    live: &inventory::SourceInventory,
    now: &str,
    cancellation: &CancellationToken,
) -> CognitionResult<Snapshot> {
    let name = format!(
        "source-snapshot-{}",
        live.hash.get(..16).unwrap_or(&live.hash)
    );
    let published = paths.generation_root.join(&name);
    let staged = paths
        .generation_root
        .join(format!(".refresh-{}", uuid::Uuid::new_v4()));
    ensure_data_authority(data_root, &[&published, &staged])?;
    let stage = SnapshotStage {
        data_root: data_root.to_owned(),
        generation_root: paths.generation_root.clone(),
        name,
        staged,
        as_of: now.to_owned(),
        expected: ExpectedSnapshot {
            hash: live.hash.clone(),
            inventory: live.inventory.clone(),
            canonical_revision: live.canonical_revision,
        },
        cancellation: cancellation.clone(),
    };
    tokio::task::spawn_blocking(move || stage.run())
        .await
        .map_err(|source| error(CognitionCode::MemorySnapshotChanged).with_source(source))?
}

/// The leased manifest update that points the candidate at its new snapshot.
struct Repoint<'a> {
    data_root: &'a Path,
    paths: &'a CandidatePaths,
    generation_id: &'a str,
    observed: &'a Observed,
    live: &'a inventory::SourceInventory,
    snapshot: &'a Snapshot,
    new_snapshot_id: &'a str,
    witnesses: (&'a LiveWitness, &'a CandidateWitness),
}

impl Repoint<'_> {
    async fn run(
        &self,
        lease: &CognitionWriteLease,
        cancellation: &CancellationToken,
    ) -> CognitionResult<()> {
        lease
            .assert_for_path(&self.paths.lock)
            .map_err(|source| error(CognitionCode::MemoryWriteBusy).with_source(source))?;
        if cancellation.is_cancelled() {
            return Err(error(CognitionCode::MemoryOperationAborted));
        }
        let (live_witness, candidate) = self.witnesses;
        live_witness.assert_current()?;
        live_witness.assert_public_revision(self.live.canonical_revision)?;
        candidate.assert_current(&self.observed.handle).await?;
        assert_building_inactive(
            self.data_root,
            self.paths,
            self.generation_id,
            self.observed,
        )?;
        let mut current = read_manifest(&self.paths.manifest)?;
        self.repoint(&mut current);
        ensure_data_authority(
            self.data_root,
            &[&self.paths.manifest, &self.snapshot.path, &self.paths.lock],
        )?;
        durable::write_json(&self.paths.manifest, &current)
    }

    /// Points the manifest at the new snapshot. Counts and qualification reset;
    /// the first snapshot stays the delta base.
    fn repoint(&self, manifest: &mut GenerationManifest) {
        let old_snapshot_id = &self.observed.snapshot_id;
        let base_snapshot_id = self
            .observed
            .manifest
            .canonical_snapshot
            .as_ref()
            .and_then(|previous| previous.base_snapshot_id.clone())
            .unwrap_or_else(|| old_snapshot_id.clone());
        manifest.state = Some(GenerationState::Building);
        manifest.canonical_snapshot_id = Some(self.new_snapshot_id.to_owned());
        manifest.canonical_snapshot_path = Some(format!(
            "{}/runtime/conversation-store.sqlite",
            self.snapshot.name
        ));
        manifest.canonical_snapshot = Some(CanonicalSnapshot {
            file_sha256: self.snapshot.sha256.clone(),
            bytes: self.snapshot.bytes,
            duration_ms: self.snapshot.duration_ms,
            canonical_revision: self.live.canonical_revision,
            base_snapshot_id: Some(base_snapshot_id),
            delta_from_snapshot_id: Some(old_snapshot_id.clone()),
        });
        manifest.source_inventory_hash = Some(self.live.hash.clone());
        manifest.registered_source_count = Some(0);
        manifest.unaccounted_source_count = Some(self.live.source_count as u64);
        manifest.required_acceptance_passed = Some(false);
        manifest.readiness = None;
    }
}

/// Blocking-pool work that publishes `generation_root/name`.
struct SnapshotStage {
    data_root: PathBuf,
    generation_root: PathBuf,
    name: String,
    staged: PathBuf,
    as_of: String,
    expected: ExpectedSnapshot,
    cancellation: CancellationToken,
}

impl SnapshotStage {
    /// Publishes the snapshot unless an identical one already exists, then
    /// proves the published copy has the expected inventory.
    fn run(self) -> CognitionResult<Snapshot> {
        let published = self.generation_root.join(&self.name);
        ensure_data_authority(
            &self.data_root,
            &[&self.generation_root, &published, &self.staged],
        )?;
        let started = SystemTime::now();
        if !published.exists() {
            if self.staged.exists() {
                return Err(error(CognitionCode::MemorySnapshotChanged));
            }
            let result = self.publish(&published);
            if result.is_err() {
                let _ = fs::remove_dir_all(&self.staged);
            }
            result?;
        }
        let canonical = published.join("runtime/conversation-store.sqlite");
        let actual = inventory::read(&published, &canonical, &self.as_of, &self.cancellation)?;
        if !self.expected.matches(&actual) {
            return Err(error(CognitionCode::MemorySnapshotChanged));
        }
        Ok(Snapshot {
            bytes: fs::metadata(&canonical).map_err(io_error)?.len(),
            sha256: hash_file(&canonical)?,
            duration_ms: elapsed_ms(started),
            path: published,
            name: self.name,
        })
    }

    fn publish(&self, published: &Path) -> CognitionResult<()> {
        let staged_snapshot = self.staged.join("runtime/conversation-store.sqlite");
        let source = self.data_root.join("runtime/conversation-store.sqlite");
        ensure_data_authority(&self.data_root, &[&source, &staged_snapshot])?;
        vacuum_snapshot(&source, &staged_snapshot)?;
        if self.cancellation.is_cancelled() {
            return Err(error(CognitionCode::MemoryOperationAborted));
        }
        typed_snapshot::copy_typed_sources(&self.data_root, &self.staged)?;
        let copied = inventory::read(
            &self.staged,
            &staged_snapshot,
            &self.as_of,
            &self.cancellation,
        )?;
        if !self.expected.matches(&copied) {
            return Err(error(CognitionCode::MemorySnapshotChanged));
        }
        durable::write_json(
            &self.staged.join("memory-source-inventory.json"),
            &copied.inventory,
        )?;
        sync_dir(&self.staged)?;
        if published.exists() {
            return Err(error(CognitionCode::MemorySnapshotChanged));
        }
        fs::rename(&self.staged, published).map_err(io_error)?;
        sync_dir(&self.generation_root)
    }
}

fn sync_dir(path: &Path) -> CognitionResult<()> {
    File::open(path)
        .and_then(|dir| dir.sync_all())
        .map_err(io_error)
}

fn assert_building_inactive(
    data_root: &Path,
    paths: &CandidatePaths,
    generation_id: &str,
    observed: &Observed,
) -> CognitionResult<()> {
    ensure_data_authority(data_root, &[&paths.manifest, &paths.active])?;
    let manifest = read_manifest(&paths.manifest)?;
    let active: DescriptorView =
        serde_json::from_slice(&fs::read(&paths.active).map_err(|source| {
            error(CognitionCode::MemoryGenerationUnavailable).with_source(source)
        })?)
        .map_err(|source| error(CognitionCode::MemoryGenerationUnavailable).with_source(source))?;
    if !manifest.is_for(generation_id)
        || !manifest.is_v2_in(GenerationState::Building)
        || manifest.canonical_snapshot_id.as_deref() != Some(observed.snapshot_id.as_str())
        || manifest.source_inventory_hash.as_deref() != Some(observed.inventory_hash.as_str())
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
