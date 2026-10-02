//! Durable compare-and-swap for the active generation descriptor.
//!
//! [`capture_active_descriptor`] observes the descriptor; a transition commits
//! only while the full descriptor (compared as `JSON.stringify` output) and the
//! target manifest bytes still match that observation.

use crate::cognition::CognitionCode;
use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::{
    cognition::{CognitionError, CognitionPathEnvironment, CognitionResult, ensure_data_authority},
    coordination::CognitionWriteLease,
};

use super::super::initialize::durable;
use super::super::manifest::{
    ACTIVE_DESCRIPTOR_SCHEMA, ActiveDescriptor, GenerationFormat, GenerationManifest,
    GenerationState, ProjectionMode,
};

/// A validated descriptor and the exact form it was observed in.
#[derive(Clone, Debug)]
pub(super) struct DescriptorCapture {
    /// `JSON.stringify` of the stored descriptor, key order preserved.
    pub(super) stringified: String,
    pub(super) fields: ActiveDescriptor,
}

impl DescriptorCapture {
    fn of(descriptor: &ActiveDescriptor) -> CognitionResult<Self> {
        let value = serde_json::to_value(descriptor).map_err(|source| {
            error(CognitionCode::MemoryGenerationUnavailable).with_source(source)
        })?;
        Ok(Self {
            stringified: stringify(&value)?,
            fields: descriptor.clone(),
        })
    }
}

pub(super) fn capture_active_descriptor(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
) -> CognitionResult<DescriptorCapture> {
    let memory_root = environment.memory_root(data_root);
    let descriptor_path = active_descriptor_path(&memory_root);
    ensure_data_authority(data_root, &[&memory_root, &descriptor_path])?;
    read_descriptor(&descriptor_path)
}

/// The descriptor that makes `generation_id` the serving generation.
pub(in crate::cognition::generation) fn next_descriptor(
    generation_id: &str,
    previous_generation_id: &str,
    activated_at: &str,
    projection_mode: ProjectionMode,
) -> ActiveDescriptor {
    ActiveDescriptor::new(
        generation_id,
        Some(previous_generation_id),
        activated_at,
        projection_mode,
    )
}

/// What a descriptor transition must still observe when it commits.
pub(super) struct TransitionGuard<'a> {
    pub(super) expected: &'a DescriptorCapture,
    pub(super) target_generation_id: &'a str,
    pub(super) target_manifest_sha256: &'a str,
}

/// Installs the next descriptor only when both the full current descriptor and
/// the target manifest bytes still match the observations made by the caller.
pub(super) fn commit_descriptor_transition(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    lease: &CognitionWriteLease,
    guard: &TransitionGuard<'_>,
    next_descriptor: &ActiveDescriptor,
) -> CognitionResult<DescriptorCapture> {
    assert_cutover_lease(data_root, environment, lease)?;
    validate_descriptor(&guard.expected.fields)?;
    let mut next_descriptor = next_descriptor.clone();
    if next_descriptor.generation_id != guard.expected.fields.generation_id {
        if next_descriptor.previous_generation_id.as_deref()
            == Some(&guard.expected.fields.generation_id)
        {
            next_descriptor.previous_storage_generation_id =
                guard.expected.fields.storage_generation_id.clone();
        }
        if guard.expected.fields.previous_generation_id.as_deref()
            == Some(&next_descriptor.generation_id)
        {
            next_descriptor.storage_generation_id =
                guard.expected.fields.previous_storage_generation_id.clone();
        }
    }
    validate_descriptor(&next_descriptor)?;
    if !valid_generation_id(guard.target_generation_id)
        || next_descriptor.generation_id != guard.target_generation_id
    {
        return Err(error(CognitionCode::MemoryGenerationChanged));
    }

    let memory_root = environment.memory_root(data_root);
    let descriptor_path = active_descriptor_path(&memory_root);
    let target_manifest_path = manifest_path(&memory_root, guard.target_generation_id)?;
    let paths = [
        memory_root.as_path(),
        &descriptor_path,
        &target_manifest_path,
        &environment.consolidation_lock(data_root),
    ];
    ensure_data_authority(data_root, &paths)?;

    let current = read_descriptor(&descriptor_path)?;
    if current.fields != guard.expected.fields || current.stringified != guard.expected.stringified
    {
        return Err(error(CognitionCode::MemoryGenerationChanged));
    }

    let target_manifest = fs::read(&target_manifest_path).map_err(io_unavailable)?;
    if sha256(&target_manifest) != guard.target_manifest_sha256 {
        return Err(error(CognitionCode::MemoryGenerationChanged));
    }

    // Recheck containment at the mutation boundary. The lease coordinates other
    // writers; this check keeps configured paths inside mutable DATA.
    ensure_data_authority(data_root, &paths)?;
    durable::write_json(&descriptor_path, &next_descriptor)?;
    DescriptorCapture::of(&next_descriptor)
}

/// Repairs only the manifest states named by the descriptor installed by a
/// successful CAS. Repeating this after a partial write is safe and idempotent.
pub(super) fn reconcile_committed_manifest_states(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    lease: &CognitionWriteLease,
    committed: &DescriptorCapture,
) -> CognitionResult<()> {
    assert_cutover_lease(data_root, environment, lease)?;
    let expected = &committed.fields;
    validate_descriptor(expected)?;
    let Some(previous_generation_id) = expected.previous_generation_id.as_deref() else {
        return Err(error(CognitionCode::MemoryGenerationChanged));
    };
    if previous_generation_id == expected.generation_id {
        return Err(error(CognitionCode::MemoryGenerationChanged));
    }

    let memory_root = environment.memory_root(data_root);
    let descriptor_path = active_descriptor_path(&memory_root);
    let target_manifest_path = manifest_path(&memory_root, &expected.generation_id)?;
    let previous_manifest_path = manifest_path(&memory_root, previous_generation_id)?;
    let lock = environment.consolidation_lock(data_root);
    let paths = [
        memory_root.as_path(),
        &descriptor_path,
        &target_manifest_path,
        &previous_manifest_path,
        &lock,
    ];
    ensure_data_authority(data_root, &paths)?;

    let current = read_descriptor(&descriptor_path)?;
    if current.fields != *expected || current.stringified != committed.stringified {
        return Err(error(CognitionCode::MemoryGenerationChanged));
    }

    let mut target_manifest = read_manifest(&target_manifest_path, &expected.generation_id)?;
    let mut previous_manifest = read_manifest(&previous_manifest_path, previous_generation_id)?;
    validate_manifest_pair(
        &target_manifest,
        &expected.generation_id,
        &previous_manifest,
        previous_generation_id,
        expected.projection_mode,
    )?;

    ensure_data_authority(data_root, &paths)?;
    if target_manifest.state != Some(GenerationState::Active) {
        target_manifest.state = Some(GenerationState::Active);
        durable::write_json(&target_manifest_path, &target_manifest)?;
    }

    // The descriptor remains the authority even when a process stopped between
    // its CAS and either manifest update. Do not touch other generations.
    ensure_data_authority(
        data_root,
        &[
            &memory_root,
            &descriptor_path,
            &previous_manifest_path,
            &lock,
        ],
    )?;
    if previous_manifest.state != Some(GenerationState::Retired) {
        previous_manifest.state = Some(GenerationState::Retired);
        durable::write_json(&previous_manifest_path, &previous_manifest)?;
    }
    Ok(())
}

fn assert_cutover_lease(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    lease: &CognitionWriteLease,
) -> CognitionResult<()> {
    lease
        .assert_for_path(&environment.consolidation_lock(data_root))
        .map_err(|source| error(CognitionCode::MemoryWriteBusy).with_source(source))?;
    if lease.owner().purpose != "cutover" {
        return Err(error(CognitionCode::MemoryGenerationChanged));
    }
    Ok(())
}

/// Reads and validates the stored descriptor, keeping its stringified form.
fn read_descriptor(path: &Path) -> CognitionResult<DescriptorCapture> {
    let bytes = fs::read(path).map_err(io_unavailable)?;
    // Passthrough: the parsed document is only stringified for the CAS compare.
    let raw: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|source| error(CognitionCode::MemoryGenerationUnavailable).with_source(source))?;
    let fields = ActiveDescriptor::deserialize(&raw)
        .map_err(|source| error(CognitionCode::MemoryGenerationUnavailable).with_source(source))?;
    validate_descriptor(&fields)?;
    Ok(DescriptorCapture {
        stringified: stringify(&raw)?,
        fields,
    })
}

fn validate_descriptor(descriptor: &ActiveDescriptor) -> CognitionResult<()> {
    if [
        descriptor.storage_generation_id.as_deref(),
        descriptor.previous_storage_generation_id.as_deref(),
    ]
    .into_iter()
    .flatten()
    .any(|id| !valid_generation_id(id))
        || descriptor.schema != ACTIVE_DESCRIPTOR_SCHEMA
        || !valid_generation_id(&descriptor.generation_id)
        || descriptor
            .previous_generation_id
            .as_deref()
            .is_some_and(|previous| !valid_generation_id(previous))
    {
        return Err(error(CognitionCode::MemoryGenerationUnavailable));
    }
    Ok(())
}

fn read_manifest(path: &Path, expected_id: &str) -> CognitionResult<GenerationManifest> {
    let manifest = GenerationManifest::read(path, CognitionCode::MemoryGenerationUnavailable)?;
    if !manifest.is_for(expected_id) || manifest.format.is_none() || manifest.state.is_none() {
        return Err(error(CognitionCode::MemoryGenerationChanged));
    }
    Ok(manifest)
}

/// The descriptor transition must be one this module knows how to finish.
fn validate_manifest_pair(
    target: &GenerationManifest,
    target_id: &str,
    previous: &GenerationManifest,
    previous_id: &str,
    projection_mode: ProjectionMode,
) -> CognitionResult<()> {
    let target_is_v2 = target.format == Some(GenerationFormat::V2);
    let running = projection_mode == ProjectionMode::Running;
    let target_transition_known = match target.state {
        // A retired target can be resumed for source-equivalent build; when
        // unchanged qualification is still bound, rollback may reuse it.
        Some(GenerationState::Building) => {
            target_is_v2
                && running
                && target.required_acceptance_passed == Some(true)
                && target
                    .readiness
                    .as_ref()
                    .is_some_and(|readiness| readiness.ready)
                && target.acceptance_binding.is_some()
        }
        // A ready v2 candidate is activated, an active target is an already
        // applied retry, and a retired target is a rollback candidate.
        Some(GenerationState::Ready) => target_is_v2 && running,
        Some(GenerationState::Active | GenerationState::Retired) => {
            target.format.map(ProjectionMode::for_format) == Some(projection_mode)
        }
        None => false,
    };
    if target_id == previous_id
        || !target_transition_known
        || !matches!(
            previous.state,
            Some(GenerationState::Active | GenerationState::Retired)
        )
    {
        return Err(error(CognitionCode::MemoryGenerationChanged));
    }
    Ok(())
}

fn stringify(value: &serde_json::Value) -> CognitionResult<String> {
    butler_core::json::stringify(value)
        .map_err(|source| error(CognitionCode::MemoryGenerationUnavailable).with_source(source))
}

fn active_descriptor_path(memory_root: &Path) -> PathBuf {
    memory_root.join("active-generation.json")
}

fn manifest_path(memory_root: &Path, generation_id: &str) -> CognitionResult<PathBuf> {
    if !valid_generation_id(generation_id) {
        return Err(error(CognitionCode::MemoryGenerationVersionUnsupported));
    }
    Ok(memory_root
        .join("generations")
        .join(generation_id)
        .join("manifest.json"))
}

fn valid_generation_id(value: &str) -> bool {
    value.len() == 36
        && value
            .bytes()
            .all(|byte| (byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()) || byte == b'-')
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn io_unavailable(error: std::io::Error) -> CognitionError {
    CognitionError::new(
        CognitionCode::MemoryGenerationUnavailable,
        error.to_string(),
    )
    .with_source(error)
}

fn error(code: CognitionCode) -> CognitionError {
    CognitionError::new(code, code.as_str())
}
