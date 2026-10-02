//! Offline SQLite copy and active-descriptor CAS retained for alias-postings issue #435.
#![allow(dead_code, reason = "reserved for alias-postings issue #435")]
//!
//! [`capture_active_descriptor`] observes the descriptor; a transition commits
//! only while the full descriptor (compared as `JSON.stringify` output) and the
//! target manifest bytes still match that observation.

use crate::cognition::CognitionCode;
use std::{
    fs,
    path::{Path, PathBuf},
};

use butler_platform::sqlite;
use rusqlite::{OpenFlags, params};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::{
    cognition::{CognitionError, CognitionPathEnvironment, CognitionResult, ensure_data_authority},
    coordination::CognitionWriteLease,
};

use super::initialize::durable;
use super::manifest::{ACTIVE_DESCRIPTOR_SCHEMA, ActiveDescriptor, ProjectionMode};

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
    validate_descriptor(next_descriptor)?;
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
    durable::write_json(&descriptor_path, next_descriptor)?;
    DescriptorCapture::of(next_descriptor)
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
    if descriptor.schema != ACTIVE_DESCRIPTOR_SCHEMA
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

/// Writes a consistent copy of the SQLite store at `source` to `target` with
/// `VACUUM INTO`, then syncs the copy and its directory.
pub(super) fn vacuum_snapshot(source: &Path, target: &Path) -> CognitionResult<()> {
    let parent = target
        .parent()
        .ok_or_else(|| error(CognitionCode::MemorySnapshotChanged))?;
    durable::create_dir(parent)?;
    let snapshot_changed = |source| error(CognitionCode::MemorySnapshotChanged).with_source(source);
    let db = sqlite::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(snapshot_changed)?;
    let path = target
        .to_str()
        .ok_or_else(|| error(CognitionCode::MemorySnapshotChanged))?;
    db.execute("VACUUM INTO ?1", params![path])
        .map_err(snapshot_changed)?;
    db.close().map_err(|(_, source)| snapshot_changed(source))?;
    sync(target)?;
    sync(parent)
}

fn sync(path: &Path) -> CognitionResult<()> {
    butler_platform::secure_fs::sync_path(path).map_err(io_error)
}

fn io_error(error: std::io::Error) -> CognitionError {
    CognitionError::new(CognitionCode::MemoryRebuildIoError, error.to_string()).with_source(error)
}
