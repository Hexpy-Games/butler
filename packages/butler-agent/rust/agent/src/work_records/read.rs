use std::path::Path;

use serde_json::Value;

#[derive(Clone, Copy)]
pub(crate) enum ReadAvailability {
    BestEffort,
    Strict,
}

/// A work record could not be read under strict availability.
///
/// Every variant renders the wire code `memory_source_unavailable`, as before;
/// the variant and source say what actually failed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum WorkRecordReadError {
    /// Reading a record file or listing a record directory failed.
    #[error("memory_source_unavailable")]
    Io(#[from] std::io::Error),
    /// A record file is not valid JSON or does not match its schema.
    #[error("memory_source_unavailable")]
    Json(#[from] serde_json::Error),
    /// Re-encoding a record for its revision hash failed.
    #[error("memory_source_unavailable")]
    Encode(#[from] crate::json::JsonError),
    /// A record is structurally invalid: a required field is missing or has
    /// the wrong type, or the records root has no parent.
    #[error("memory_source_unavailable")]
    Malformed,
}

pub(super) fn text(
    path: &Path,
    availability: ReadAvailability,
) -> Result<Option<String>, WorkRecordReadError> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) if matches!(availability, ReadAvailability::BestEffort) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

pub(super) fn json(
    path: &Path,
    availability: ReadAvailability,
) -> Result<Option<Value>, WorkRecordReadError> {
    let Some(text) = text(path, availability)? else {
        return Ok(None);
    };
    match serde_json::from_str(&text) {
        Ok(value) => Ok(Some(value)),
        Err(_) if matches!(availability, ReadAvailability::BestEffort) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

pub(super) struct Snapshot {
    pub plan: Value,
    pub review: Option<Value>,
    pub status: String,
    pub latest_attempt: Option<String>,
}

pub(super) fn snapshot(
    directory: &Path,
    availability: ReadAvailability,
) -> Result<Option<Snapshot>, WorkRecordReadError> {
    if !directory.exists() {
        return Ok(None);
    }
    let Some(plan) = json(&directory.join("plan.json"), availability)? else {
        return Ok(None);
    };
    if plan.get("type").and_then(Value::as_str) != Some("planned") {
        return Ok(None);
    }
    let attempts_root = directory.join("attempts");
    let mut attempts = Vec::new();
    let listing = (|| {
        if !attempts_root.exists() {
            return Ok(());
        }
        for entry in std::fs::read_dir(&attempts_root)? {
            let entry = entry?;
            if entry.path().exists() {
                attempts.push(entry.file_name().to_string_lossy().into_owned());
            }
        }
        Ok::<(), std::io::Error>(())
    })();
    if let Err(error) = listing {
        if matches!(availability, ReadAvailability::Strict) {
            return Err(error.into());
        }
        attempts.clear();
    }
    attempts.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    let latest_attempt = attempts.pop();
    if let Some(latest) = &latest_attempt {
        // These source reads still participate in strict availability even
        // though this consumer does not retain their text.
        text(&attempts_root.join(latest).join("result.md"), availability)?;
    }
    let status = text(&directory.join("status"), availability)?.unwrap_or_default();
    let review = json(&directory.join("review.json"), availability)?;
    json(&directory.join("decision.json"), availability)?;
    text(&directory.join("public-report.md"), availability)?;
    Ok(Some(Snapshot {
        plan,
        review,
        status: crate::public_text::trim_js_whitespace(&status).into(),
        latest_attempt,
    }))
}
