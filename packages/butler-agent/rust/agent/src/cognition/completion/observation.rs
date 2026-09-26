use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::CompletionNotice;
use crate::cognition::{CognitionError, CognitionResult};

pub(super) struct PublishedObservation {
    pub job_id: String,
    pub session_id: String,
    pub turn_id: String,
    pub generation: Value,
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
        .map(crate::public_text::trim_js_whitespace)
        .filter(|value| !value.is_empty());
    let generation = input.outcome_generation.floor().max(1.0);
    let generation_json: Value = if generation.is_finite() {
        serde_json::from_str(&generation.to_string()).map_err(|error| {
            CognitionError::new(
                "completion_observation_generation_invalid",
                error.to_string(),
            )
        })?
    } else {
        Value::Null
    };
    let base = json!({
        "schema_version": "butler.conversation-completion-observation.v1",
        "job_id": job_id,
        "scope": if project.is_some() { "project" } else { "global" },
        "project_id": project,
        "runtime_session_id": required(&input.runtime_session_id)?,
        "conversation_session_id": required(&input.conversation_session_id)?,
        "conversation_turn_id": required(&input.conversation_turn_id)?,
        "inbound_message_id": required(&input.inbound_message_id)?,
        "outbound_message_id": required(&input.outbound_message_id)?,
        "outcome_generation": generation_json,
        "completed_at": required(&input.completed_at)?,
    });
    let mut value = base.as_object().expect("object literal").clone();
    value.insert(
        "integrity_sha256".into(),
        Value::String(sha(canonical(&base)?.as_bytes())),
    );
    let observation = Value::Object(value);
    let path = root
        .join("queue/completion-observations")
        .join(format!("{job_id}.json"));
    if path.exists() {
        let existing = fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok());
        let valid = existing.as_ref().is_some_and(|old| {
            old["schema_version"] == "butler.conversation-completion-observation.v1"
                && old["job_id"] == job_id
                && integrity_valid(old)
                && canonical(old).ok() == canonical(&observation).ok()
        });
        if !valid {
            return Err(error("completion_observation_conflict"));
        }
    } else {
        write_atomic(&path, &observation)?;
    }
    Ok(PublishedObservation {
        job_id,
        session_id: input.conversation_session_id.clone(),
        turn_id: input.conversation_turn_id.clone(),
        generation: generation_json,
    })
}

fn required(value: &str) -> CognitionResult<&str> {
    let trimmed = crate::public_text::trim_js_whitespace(value);
    if trimmed.is_empty() {
        Err(error("completion_observation_identity_missing"))
    } else {
        Ok(trimmed)
    }
}

pub(super) fn read_verified(root: &Path, job_id: &str) -> CognitionResult<Option<Value>> {
    if job_id.is_empty()
        || !job_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    {
        return Ok(None);
    }
    let path = root
        .join("queue/completion-observations")
        .join(format!("{job_id}.json"));
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(_) => return Ok(None),
    };
    let value: Value = match serde_json::from_str(&content) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    Ok(
        (value["schema_version"] == "butler.conversation-completion-observation.v1"
            && value["job_id"] == job_id
            && integrity_valid(&value))
        .then_some(value),
    )
}

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

fn canonical(value: &Value) -> CognitionResult<String> {
    // Known observation keys are ASCII; serde_json's sorted map is the source
    // locale-sorted canonical object order for this record shape.
    serde_json::to_string(value).map_err(|error| {
        CognitionError::new("completion_observation_json_error", error.to_string())
    })
}

fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn write_atomic(path: &Path, value: &Value) -> CognitionResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| error("completion_observation_path_invalid"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(parent)
            .map_err(io_error)?;
    }
    #[cfg(not(unix))]
    fs::create_dir_all(parent).map_err(io_error)?;
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| error("completion_observation_clock_invalid"))?
        .as_millis();
    let temp = path.with_extension(format!("json.{}.{millis}.tmp", std::process::id()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
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
    CognitionError::new("completion_observation_io_error", error.to_string())
}
fn error(code: &'static str) -> CognitionError {
    CognitionError::new(code, code)
}
