//! First rebuild on a pre-generation DATA root: adopt the legacy memory as an
//! active `legacy` baseline generation so the rebuild has a predecessor.

use super::*;
use crate::cognition::CognitionCode;
use crate::cognition::generation::manifest::{
    ACTIVE_DESCRIPTOR_SCHEMA, ActiveDescriptor, DescriptorView, GenerationFormat,
    GenerationManifest, GenerationState, InitializationOrigin, NewManifest, ProjectionMode,
};

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
    let lease = crate::cognition::generation::stage::acquire_abortable(
        coordinator,
        lock,
        "cutover",
        cancellation,
    )
    .await?;
    let adoption = Adoption {
        data_root: data_root.to_owned(),
        memory_root: memory_root.to_owned(),
        canonical: canonical.to_owned(),
        lock: lock.to_owned(),
        now: now.to_owned(),
        cancellation: cancellation.to_owned(),
        first,
    };
    crate::cognition::generation::stage::leased(
        lease,
        CognitionCode::MemoryGenerationUnavailable,
        move |lease| adoption.adopt(lease),
    )
    .await
}

/// Inputs of the leased adoption step.
struct Adoption {
    data_root: PathBuf,
    memory_root: PathBuf,
    canonical: PathBuf,
    lock: PathBuf,
    now: String,
    cancellation: CancellationToken,
    /// Inventory observed before waiting for the write gate.
    first: inventory::SourceInventory,
}

impl Adoption {
    fn adopt(&self, lease: &crate::coordination::CognitionWriteLease) -> CognitionResult<()> {
        lease
            .assert_for_path(&self.lock)
            .map_err(|source| error(CognitionCode::MemoryWriteBusy).with_source(source))?;
        let descriptor = self.memory_root.join("active-generation.json");
        if descriptor.exists() {
            return validate_active_descriptor(&self.data_root, &descriptor);
        }
        let second = inventory::read(
            &self.data_root,
            &self.canonical,
            &self.now,
            &self.cancellation,
        )?;
        if second.hash != self.first.hash
            || second.canonical_revision != self.first.canonical_revision
        {
            return Err(error(CognitionCode::MemorySourceChanged));
        }
        let generations = self.memory_root.join("generations");
        durable::create_dir(&generations)?;
        let generation_id = match self.reusable_baseline(&generations)? {
            Some(id) => id,
            None => self.write_baseline(&generations)?,
        };
        ensure_data_authority(&self.data_root, &[&descriptor])?;
        durable::write_json(
            &descriptor,
            &ActiveDescriptor::new(&generation_id, None, &self.now, ProjectionMode::Paused),
        )
    }

    /// A baseline left by an interrupted earlier adoption of the same sources.
    fn reusable_baseline(&self, generations: &Path) -> CognitionResult<Option<String>> {
        let mut reusable = None;
        for entry in fs::read_dir(generations).map_err(io_error)? {
            let path = entry.map_err(io_error)?.path();
            let manifest_path = path.join("manifest.json");
            if !manifest_path.is_file() {
                continue;
            }
            ensure_data_authority(&self.data_root, &[&path, &manifest_path])?;
            let manifest = GenerationManifest::parse(
                &fs::read(&manifest_path).map_err(io_error)?,
                CognitionCode::MemoryGenerationUnavailable,
            )?;
            if !self.is_adopted_baseline(&manifest) {
                continue;
            }
            let id = manifest
                .generation_id
                .ok_or_else(|| error(CognitionCode::MemoryGenerationUnavailable))?;
            if path.file_name().and_then(|name| name.to_str()) != Some(id.as_str())
                || reusable.is_some()
            {
                return Err(error(CognitionCode::MemoryGenerationRecoveryRequired));
            }
            reusable = Some(id);
        }
        Ok(reusable)
    }

    fn is_adopted_baseline(&self, manifest: &GenerationManifest) -> bool {
        manifest.format == Some(GenerationFormat::Legacy)
            && manifest.initialization_origin == Some(InitializationOrigin::Legacy)
            && manifest.state == Some(GenerationState::Active)
            && manifest.source_inventory_hash.as_deref() == Some(self.first.hash.as_str())
    }

    fn write_baseline(&self, generations: &Path) -> CognitionResult<String> {
        let id = uuid::Uuid::new_v4().to_string();
        let root = generations.join(&id);
        ensure_data_authority(&self.data_root, &[&root])?;
        durable::create_dir(&root)?;
        let legacy_hash =
            butler_core::json::stringify(&json!(["legacy-baseline", id, self.first.hash]))
                .map_err(|source| {
                    error(CognitionCode::MemoryInventoryIncomplete).with_source(source)
                })?;
        let manifest = GenerationManifest::new(
            NewManifest {
                generation_id: &id,
                format: GenerationFormat::Legacy,
                state: GenerationState::Active,
                origin: InitializationOrigin::Legacy,
                canonical_snapshot_id: format!("{:x}", Sha256::digest(legacy_hash.as_bytes())),
                source_inventory_hash: self.first.hash.clone(),
                unaccounted_source_count: self.first.source_count as u64,
            },
            None,
        );
        durable::write_json(&root.join("manifest.json"), &manifest)?;
        Ok(id)
    }
}

fn validate_active_descriptor(data_root: &Path, path: &Path) -> CognitionResult<()> {
    ensure_data_authority(data_root, &[path])?;
    let descriptor: DescriptorView =
        serde_json::from_slice(&fs::read(path).map_err(|source| {
            error(CognitionCode::MemoryGenerationUnavailable).with_source(source)
        })?)
        .map_err(|source| error(CognitionCode::MemoryGenerationUnavailable).with_source(source))?;
    if descriptor.schema.as_deref() != Some(ACTIVE_DESCRIPTOR_SCHEMA)
        || descriptor.generation_id.is_none_or(|id| id.is_empty())
    {
        return Err(error(CognitionCode::MemoryGenerationUnavailable));
    }
    Ok(())
}
