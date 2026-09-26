//! Durable compare-and-swap for the active generation descriptor.

use std::{
    fs,
    path::{Path, PathBuf},
};

use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::{
    cognition::{CognitionError, CognitionPathEnvironment, CognitionResult, ensure_data_authority},
    coordination::CognitionWriteLease,
};

use super::super::initialize::durable;

const ACTIVE_DESCRIPTOR_SCHEMA: &str = "butler.memory-active-generation.v2";
const GENERATION_MANIFEST_SCHEMA: &str = "butler.memory-generation.v2";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct ActiveDescriptorFields {
    pub(super) schema: String,
    pub(super) generation_id: String,
    pub(super) previous_generation_id: Option<String>,
    pub(super) activated_at: String,
    pub(super) projection_mode: String,
}

#[derive(Clone, Debug)]
pub(super) struct DescriptorCapture {
    /// The parsed descriptor retains source key order for JSON.stringify-style comparison.
    pub(super) raw: Value,
    pub(super) fields: ActiveDescriptorFields,
}

pub(super) fn capture_active_descriptor(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
) -> CognitionResult<DescriptorCapture> {
    let memory_root = environment.memory_root(data_root);
    let descriptor_path = active_descriptor_path(&memory_root);
    ensure_data_authority(data_root, &[&memory_root, &descriptor_path])?;
    let raw = read_json(&descriptor_path)?;
    let fields = parse_descriptor_fields(&raw)?;
    Ok(DescriptorCapture { raw, fields })
}

/// Installs the next descriptor only when both the full current descriptor and
/// the target manifest bytes still match the observations made by the caller.
pub(super) fn commit_descriptor_transition(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    lease: &CognitionWriteLease,
    expected_descriptor: &Value,
    target_generation_id: &str,
    expected_target_manifest_sha256: &str,
    next_descriptor: Value,
) -> CognitionResult<Value> {
    assert_cutover_lease(data_root, environment, lease)?;
    let expected_fields = parse_descriptor_fields(expected_descriptor)?;
    let next_fields = parse_descriptor_fields(&next_descriptor)?;
    if !valid_generation_id(target_generation_id)
        || next_fields.generation_id != target_generation_id
    {
        return Err(error("memory_generation_changed"));
    }

    let memory_root = environment.memory_root(data_root);
    let descriptor_path = active_descriptor_path(&memory_root);
    let target_manifest_path = manifest_path(&memory_root, target_generation_id)?;
    ensure_data_authority(
        data_root,
        &[
            &memory_root,
            &descriptor_path,
            &target_manifest_path,
            &environment.consolidation_lock(data_root),
        ],
    )?;

    let current = read_json(&descriptor_path)?;
    let current_fields = parse_descriptor_fields(&current)?;
    if current_fields != expected_fields
        || !same_json_stringification(&current, expected_descriptor)?
    {
        return Err(error("memory_generation_changed"));
    }

    let target_manifest = fs::read(&target_manifest_path).map_err(io_unavailable)?;
    if sha256(&target_manifest) != expected_target_manifest_sha256 {
        return Err(error("memory_generation_changed"));
    }

    // Recheck containment at the mutation boundary. The lease coordinates other
    // writers; this check keeps configured paths inside mutable DATA.
    ensure_data_authority(
        data_root,
        &[
            &memory_root,
            &descriptor_path,
            &target_manifest_path,
            &environment.consolidation_lock(data_root),
        ],
    )?;
    durable::write_json(&descriptor_path, &next_descriptor)?;
    Ok(next_descriptor)
}

/// Repairs only the manifest states named by the descriptor installed by a
/// successful CAS. Repeating this after a partial write is safe and idempotent.
pub(super) fn reconcile_committed_manifest_states(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    lease: &CognitionWriteLease,
    expected_committed_descriptor: &Value,
) -> CognitionResult<()> {
    assert_cutover_lease(data_root, environment, lease)?;
    let expected_fields = parse_descriptor_fields(expected_committed_descriptor)?;
    let Some(previous_generation_id) = expected_fields.previous_generation_id.as_deref() else {
        return Err(error("memory_generation_changed"));
    };
    if previous_generation_id == expected_fields.generation_id {
        return Err(error("memory_generation_changed"));
    }

    let memory_root = environment.memory_root(data_root);
    let descriptor_path = active_descriptor_path(&memory_root);
    let target_manifest_path = manifest_path(&memory_root, &expected_fields.generation_id)?;
    let previous_manifest_path = manifest_path(&memory_root, previous_generation_id)?;
    ensure_data_authority(
        data_root,
        &[
            &memory_root,
            &descriptor_path,
            &target_manifest_path,
            &previous_manifest_path,
            &environment.consolidation_lock(data_root),
        ],
    )?;

    let current = read_json(&descriptor_path)?;
    let current_fields = parse_descriptor_fields(&current)?;
    if current_fields != expected_fields
        || !same_json_stringification(&current, expected_committed_descriptor)?
    {
        return Err(error("memory_generation_changed"));
    }

    let mut target_manifest = read_manifest(&target_manifest_path, &expected_fields.generation_id)?;
    let mut previous_manifest = read_manifest(&previous_manifest_path, previous_generation_id)?;
    validate_manifest_pair(
        &target_manifest,
        &expected_fields.generation_id,
        &previous_manifest,
        previous_generation_id,
        &expected_fields.projection_mode,
    )?;

    ensure_data_authority(
        data_root,
        &[
            &memory_root,
            &descriptor_path,
            &target_manifest_path,
            &previous_manifest_path,
            &environment.consolidation_lock(data_root),
        ],
    )?;
    if target_manifest["state"] != "active" {
        target_manifest["state"] = Value::String("active".into());
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
            &environment.consolidation_lock(data_root),
        ],
    )?;
    if previous_manifest["state"] != "retired" {
        previous_manifest["state"] = Value::String("retired".into());
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
        .map_err(|_| error("memory_write_busy"))?;
    if lease.owner().purpose != "cutover" {
        return Err(error("memory_generation_changed"));
    }
    Ok(())
}

fn parse_descriptor_fields(value: &Value) -> CognitionResult<ActiveDescriptorFields> {
    let object = value
        .as_object()
        .ok_or_else(|| error("memory_generation_unavailable"))?;
    let schema = required_string(object.get("schema"))?;
    let generation_id = required_string(object.get("generation_id"))?;
    let previous_generation_id = match object.get("previous_generation_id") {
        Some(Value::Null) => None,
        Some(Value::String(value)) if valid_generation_id(value) => Some(value.clone()),
        _ => return Err(error("memory_generation_unavailable")),
    };
    let activated_at = required_string(object.get("activated_at"))?;
    let projection_mode = required_string(object.get("projection_mode"))?;
    if schema != ACTIVE_DESCRIPTOR_SCHEMA
        || !valid_generation_id(&generation_id)
        || !matches!(projection_mode.as_str(), "running" | "paused")
    {
        return Err(error("memory_generation_unavailable"));
    }
    Ok(ActiveDescriptorFields {
        schema,
        generation_id,
        previous_generation_id,
        activated_at,
        projection_mode,
    })
}

fn required_string(value: Option<&Value>) -> CognitionResult<String> {
    value
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| error("memory_generation_unavailable"))
}

fn read_manifest(path: &Path, expected_id: &str) -> CognitionResult<Value> {
    let manifest = read_json(path)?;
    let object = manifest
        .as_object()
        .ok_or_else(|| error("memory_generation_unavailable"))?;
    if object.get("schema").and_then(Value::as_str) != Some(GENERATION_MANIFEST_SCHEMA)
        || object.get("generation_id").and_then(Value::as_str) != Some(expected_id)
        || !matches!(
            object.get("format").and_then(Value::as_str),
            Some("v2" | "legacy")
        )
        || !matches!(
            object.get("state").and_then(Value::as_str),
            Some("building" | "ready" | "active" | "retired")
        )
    {
        return Err(error("memory_generation_changed"));
    }
    Ok(manifest)
}

fn validate_manifest_pair(
    target: &Value,
    target_id: &str,
    previous: &Value,
    previous_id: &str,
    projection_mode: &str,
) -> CognitionResult<()> {
    let target_format = target.get("format").and_then(Value::as_str);
    let target_state = target.get("state").and_then(Value::as_str);
    let previous_state = previous.get("state").and_then(Value::as_str);
    let projection_matches_target = match target_format {
        Some("v2") => projection_mode == "running",
        Some("legacy") => projection_mode == "paused",
        _ => false,
    };
    let target_transition_known = match target_state {
        // A retired target can be resumed for source-equivalent build; when
        // unchanged qualification is still bound, rollback may reuse it.
        Some("building") => {
            target_format == Some("v2")
                && projection_mode == "running"
                && target["required_acceptance_passed"] == true
                && target["readiness"]["ready"] == true
                && target["acceptance_binding"].is_object()
        }
        // A ready v2 candidate is activated, an active target is an already
        // applied retry, and a retired target is a rollback candidate.
        Some("ready") => target_format == Some("v2") && projection_mode == "running",
        Some("active" | "retired") => projection_matches_target,
        _ => false,
    };
    if target_id == previous_id
        || !target_transition_known
        || !matches!(previous_state, Some("active" | "retired"))
    {
        return Err(error("memory_generation_changed"));
    }
    Ok(())
}

fn same_json_stringification(left: &Value, right: &Value) -> CognitionResult<bool> {
    let left = crate::json::stringify(left).map_err(|_| error("memory_generation_unavailable"))?;
    let right =
        crate::json::stringify(right).map_err(|_| error("memory_generation_unavailable"))?;
    Ok(left == right)
}

fn active_descriptor_path(memory_root: &Path) -> PathBuf {
    memory_root.join("active-generation.json")
}

fn manifest_path(memory_root: &Path, generation_id: &str) -> CognitionResult<PathBuf> {
    if !valid_generation_id(generation_id) {
        return Err(error("memory_generation_version_unsupported"));
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

fn read_json(path: &Path) -> CognitionResult<Value> {
    let bytes = fs::read(path).map_err(io_unavailable)?;
    serde_json::from_slice(&bytes).map_err(|_| error("memory_generation_unavailable"))
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn io_unavailable(error: std::io::Error) -> CognitionError {
    CognitionError::new("memory_generation_unavailable", error.to_string())
}

fn error(code: &'static str) -> CognitionError {
    CognitionError::new(code, code)
}
