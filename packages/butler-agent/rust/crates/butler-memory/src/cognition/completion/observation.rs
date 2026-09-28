//! Completion observations: the integrity-hashed record of a finished
//! conversation turn that a memory-sync request must match
//! (`queue/completion-observations/<job>.json`).

use crate::cognition::CognitionCode;
use crate::lenient::JsonField;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Number, Value};
use sha2::{Digest, Sha256};

use super::CompletionNotice;
use crate::cognition::{CognitionError, CognitionResult};
use crate::lenient::Arg;

const SCHEMA: &str = "butler.conversation-completion-observation.v1";

pub(super) struct PublishedObservation {
    pub job_id: String,
    pub session_id: String,
    pub turn_id: String,
    /// The outcome generation as written (`null` when not finite).
    pub generation: Option<Number>,
}

/// The observation file; the integrity hash covers every other field.
#[derive(Serialize)]
struct ObservationRecord<'a> {
    schema_version: &'static str,
    job_id: &'a str,
    scope: &'static str,
    project_id: Option<&'a str>,
    runtime_session_id: &'a str,
    conversation_session_id: &'a str,
    conversation_turn_id: &'a str,
    inbound_message_id: &'a str,
    outbound_message_id: &'a str,
    outcome_generation: Option<&'a Number>,
    completed_at: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    integrity_sha256: Option<String>,
}

/// The fields of a verified observation a sync request is matched against.
#[derive(Debug, Default, Deserialize)]
pub(super) struct ObservedTurn {
    #[serde(default)]
    pub conversation_session_id: Arg<String>,
    #[serde(default)]
    pub conversation_turn_id: Arg<String>,
    #[serde(default)]
    pub outcome_generation: Arg<Number>,
}

pub(super) fn publish(
    root: &Path,
    input: &CompletionNotice,
) -> CognitionResult<PublishedObservation> {
    let raw_generation = input.outcome_generation.to_string();
    let job_id = format!(
        "mcj_{}",
        &sha(format!("{}\0{raw_generation}", input.conversation_turn_id).as_bytes())[..32]
    );
    let project = input
        .project_id
        .as_deref()
        .map(butler_core::public_text::trim_js_whitespace)
        .filter(|value| !value.is_empty());
    let generation = input.outcome_generation.floor().max(1.0);
    let generation_json = if generation.is_finite() {
        Some(generation.to_string().parse::<Number>().map_err(|error| {
            CognitionError::new(
                CognitionCode::CompletionObservationGenerationInvalid,
                error.to_string(),
            )
            .with_source(error)
        })?)
    } else {
        None
    };
    let mut record = ObservationRecord {
        schema_version: SCHEMA,
        job_id: &job_id,
        scope: if project.is_some() {
            "project"
        } else {
            "global"
        },
        project_id: project,
        runtime_session_id: required(&input.runtime_session_id)?,
        conversation_session_id: required(&input.conversation_session_id)?,
        conversation_turn_id: required(&input.conversation_turn_id)?,
        inbound_message_id: required(&input.inbound_message_id)?,
        outbound_message_id: required(&input.outbound_message_id)?,
        outcome_generation: generation_json.as_ref(),
        completed_at: required(&input.completed_at)?,
        integrity_sha256: None,
    };
    record.integrity_sha256 = Some(sha(canonical(&record)?.as_bytes()));
    let path = root
        .join("queue/completion-observations")
        .join(format!("{job_id}.json"));
    if path.exists() {
        // Passthrough: the stored observation, verified over every field it has.
        let existing = fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok());
        let expected = canonical(&record).ok();
        let valid = existing.as_ref().is_some_and(|old| {
            old["schema_version"] == SCHEMA
                && old["job_id"] == job_id.as_str()
                && integrity_valid(old)
                && canonical(old).ok() == expected
        });
        if !valid {
            return Err(error(CognitionCode::CompletionObservationConflict));
        }
    } else {
        write_atomic(&path, &record)?;
    }
    Ok(PublishedObservation {
        job_id,
        session_id: input.conversation_session_id.clone(),
        turn_id: input.conversation_turn_id.clone(),
        generation: generation_json,
    })
}

fn required(value: &str) -> CognitionResult<&str> {
    let trimmed = butler_core::public_text::trim_js_whitespace(value);
    if trimmed.is_empty() {
        Err(error(CognitionCode::CompletionObservationIdentityMissing))
    } else {
        Ok(trimmed)
    }
}

/// The observation of `job_id` when its file exists, is the v1 schema for
/// this job, and its integrity hash holds.
pub(super) fn read_verified(root: &Path, job_id: &str) -> Option<ObservedTurn> {
    if job_id.is_empty()
        || !job_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    {
        return None;
    }
    let path = root
        .join("queue/completion-observations")
        .join(format!("{job_id}.json"));
    let Ok(content) = fs::read_to_string(path) else {
        return None;
    };
    // Passthrough: the stored observation, verified over every field it has.
    let value: Value = match serde_json::from_str(&content) {
        Ok(value) => value,
        Err(_) => return None,
    };
    (value.field("schema_version") == SCHEMA
        && value.field("job_id") == job_id
        && integrity_valid(&value))
    .then(|| crate::lenient::view(&value))
}

/// Passthrough: `value` is a stored observation; its `integrity_sha256`
/// must hash the canonical form of every other field.
fn integrity_valid(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    let mut base = object.clone();
    let Some(Value::String(expected)) = base.remove("integrity_sha256") else {
        return false;
    };
    canonical(&Value::Object(base)).is_ok_and(|text| sha(text.as_bytes()) == expected)
}

fn canonical(value: &impl Serialize) -> CognitionResult<String> {
    // Known observation keys are ASCII; serde_json's sorted map is the source
    // locale-sorted canonical object order for this record shape.
    serde_json::to_string(value).map_err(|error| {
        CognitionError::new(
            CognitionCode::CompletionObservationJsonError,
            error.to_string(),
        )
        .with_source(error)
    })
}

fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn write_atomic(path: &Path, value: &impl Serialize) -> CognitionResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| error(CognitionCode::CompletionObservationPathInvalid))?;
    butler_platform::secure_fs::create_private_dir_all(parent).map_err(io_error)?;
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|source| {
            error(CognitionCode::CompletionObservationClockInvalid).with_source(source)
        })?
        .as_millis();
    let temp = path.with_extension(format!("json.{}.{millis}.tmp", std::process::id()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        butler_platform::secure_fs::owner_only(&mut options);
        let mut file = options.open(&temp).map_err(io_error)?;
        file.write_all(canonical(value)?.as_bytes())
            .map_err(io_error)?;
        file.write_all(b"\n").map_err(io_error)?;
        drop(file);
        fs::rename(&temp, path).map_err(io_error)
    })();
    let _ = fs::remove_file(temp);
    result
}

fn io_error(error: std::io::Error) -> CognitionError {
    CognitionError::new(
        CognitionCode::CompletionObservationIoError,
        error.to_string(),
    )
    .with_source(error)
}
fn error(code: CognitionCode) -> CognitionError {
    CognitionError::new(code, code.as_str())
}
