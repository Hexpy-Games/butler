//! Reads of one TaskStore task directory under an availability policy, and
//! the typed views of its plan and review records.
//!
//! Views read leniently: every field keeps whether it was missing, `null`,
//! readable, or of another type, so each consumer applies the source's own
//! rule (a malformed field is an error for some checks and a mismatch for
//! others).

use std::path::Path;

use serde::Deserialize;
use serde_json::Value;

use crate::lenient::{Arg, Obj};

/// The v1 origin binding a task may record in `origin.json`.
#[derive(Default, Deserialize)]
pub(super) struct Origin {
    #[serde(default, deserialize_with = "crate::lenient::option")]
    pub version: Option<i64>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    pub origin_session_id: Option<String>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    pub origin_inbound_event_id: Option<String>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    pub task_summary: Option<String>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    pub transcript_ref: Option<TranscriptRef>,
}

#[derive(Default, Deserialize)]
pub(super) struct TranscriptRef {
    #[serde(default, deserialize_with = "crate::lenient::option")]
    pub path: Option<String>,
}

impl Origin {
    /// A readable v1 origin: version 1 with session, summary and transcript path.
    pub(super) fn valid(&self) -> bool {
        self.version == Some(1)
            && self.origin_session_id.is_some()
            && self.task_summary.is_some()
            && self
                .transcript_ref
                .as_ref()
                .is_some_and(|reference| reference.path.is_some())
    }
}

/// Whether an unreadable record is skipped or an error.
#[derive(Clone, Copy)]
pub enum ReadAvailability {
    /// Unreadable or invalid records read as absent.
    BestEffort,
    /// Unreadable or invalid records are errors.
    Strict,
}

/// A work record could not be read under strict availability.
///
/// Every variant renders the wire code `memory_source_unavailable`, as before;
/// the variant and source say what actually failed.
#[derive(Debug, thiserror::Error)]
pub enum WorkRecordReadError {
    /// Reading a record file or listing a record directory failed.
    #[error("memory_source_unavailable")]
    Io(#[from] std::io::Error),
    /// A record file is not valid JSON or does not match its schema.
    #[error("memory_source_unavailable")]
    Json(#[from] serde_json::Error),
    /// Re-encoding a record for its revision hash failed.
    #[error("memory_source_unavailable")]
    Encode(#[from] butler_core::json::JsonError),
    /// A record is structurally invalid: a required field is missing or has
    /// the wrong type, or the records root has no parent.
    #[error("memory_source_unavailable")]
    Malformed,
}

/// A planned task's `plan.json`.
#[derive(Debug, Default, Deserialize)]
pub(super) struct PlanRecord {
    #[serde(default, rename = "type")]
    pub kind: Arg<String>,
    #[serde(default)]
    pub goal: Arg<String>,
    #[serde(default)]
    pub internal_goal: Arg<String>,
    #[serde(default)]
    pub acceptance_criteria: Arg<Vec<Arg<String>>>,
    #[serde(default)]
    pub project: Arg<String>,
    #[serde(default)]
    pub origin_session_id: Arg<String>,
    #[serde(default)]
    pub origin_event_id: Arg<String>,
}

/// A task's `review.json`: literally `null`, or a review document (a
/// document of another shape reads with every field missing).
#[derive(Debug)]
pub(super) enum ReviewFile {
    Null,
    Document(Box<ReviewRecord>),
}

/// The reviewer's verdict on a planned task attempt.
#[derive(Debug, Default, Deserialize)]
pub(super) struct ReviewRecord {
    #[serde(default)]
    pub verdict: Arg<String>,
    #[serde(default)]
    pub attempt: Arg<f64>,
    #[serde(default)]
    pub memory_source_verified: Arg<bool>,
    #[serde(default)]
    pub goal_review: Arg<Obj<GoalReview>>,
    #[serde(default)]
    pub missing_evidence: Arg<Vec<serde::de::IgnoredAny>>,
    #[serde(default)]
    pub criteria: Arg<Vec<Arg<Obj<CriterionReview>>>>,
}

/// The review of the task's goal.
#[derive(Debug, Default, Deserialize)]
pub(super) struct GoalReview {
    #[serde(default)]
    pub goal: Arg<String>,
    #[serde(default)]
    pub verdict: Arg<String>,
}

/// The review of one acceptance criterion.
#[derive(Debug, Default, Deserialize)]
pub(super) struct CriterionReview {
    #[serde(default)]
    pub verdict: Arg<String>,
    #[serde(default)]
    pub criterion: Arg<String>,
    #[serde(default)]
    pub criterion_index: Arg<f64>,
    #[serde(default)]
    pub evidence: Arg<String>,
}

impl ReviewFile {
    fn read(value: &Value) -> Self {
        if value.is_null() {
            Self::Null
        } else {
            Self::Document(Box::new(crate::lenient::view(value)))
        }
    }

    /// The review document, unless the file is `null`.
    pub(super) fn document(&self) -> Option<&ReviewRecord> {
        match self {
            Self::Null => None,
            Self::Document(review) => Some(review),
        }
    }
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

/// A planned task's current plan, review and status.
pub(super) struct Snapshot {
    pub plan: PlanRecord,
    pub review: Option<ReviewFile>,
    pub status: String,
    pub latest_attempt: Option<String>,
}

/// The planned task in `directory`, or `None` when it is not a planned task.
/// Every file the source reads is read, so strict availability fails on any
/// of them.
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
    let plan: PlanRecord = crate::lenient::view(&plan);
    if plan.kind.valid().map(String::as_str) != Some("planned") {
        return Ok(None);
    }
    let attempts_root = directory.join("attempts");
    let latest_attempt = latest_attempt(&attempts_root, availability)?;
    if let Some(latest) = &latest_attempt {
        // These source reads still participate in strict availability even
        // though this consumer does not retain their text.
        text(&attempts_root.join(latest).join("result.md"), availability)?;
    }
    let status = text(&directory.join("status"), availability)?.unwrap_or_default();
    let review = json(&directory.join("review.json"), availability)?
        .as_ref()
        .map(ReviewFile::read);
    json(&directory.join("decision.json"), availability)?;
    text(&directory.join("public-report.md"), availability)?;
    Ok(Some(Snapshot {
        plan,
        review,
        status: butler_core::public_text::trim_js_whitespace(&status).into(),
        latest_attempt,
    }))
}

/// The last attempt directory name in UTF-16 order; a listing failure is an
/// error only under strict availability.
fn latest_attempt(
    attempts_root: &Path,
    availability: ReadAvailability,
) -> Result<Option<String>, WorkRecordReadError> {
    let mut attempts = Vec::new();
    let listing = (|| {
        if !attempts_root.exists() {
            return Ok(());
        }
        for entry in std::fs::read_dir(attempts_root)? {
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
    Ok(attempts.pop())
}
