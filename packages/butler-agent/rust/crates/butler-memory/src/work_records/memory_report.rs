//! The reviewed public report of a planned task, as outcome memory reads it.
//!
//! [`read`] accepts a `memory-report-binding.json` only when it still binds
//! the current report, result, review and plan (by hash), the latest
//! attempt, a review that verified its memory source and covers every
//! acceptance criterion with evidence, and a matching disposition.

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::read::{
    self, CriterionReview, PlanRecord, ReadAvailability, ReviewRecord, Snapshot,
    WorkRecordReadError,
};
use crate::lenient::{Arg, Obj};
use butler_core::public_text::trim_js_whitespace as trim;

#[derive(Debug, Deserialize, Serialize)]
pub(crate) struct PlannedTaskMemoryReport {
    pub schema: String,
    pub task_id: String,
    pub record_id: String,
    pub attempt: f64,
    pub result_hash: String,
    pub review_hash: String,
    pub plan_hash: String,
    pub report_hash: String,
    pub source_revision: String,
    pub disposition: String,
    pub project_id: String,
    pub observed_at: String,
    #[serde(default)]
    pub text: String,
}

/// The files a binding hashes.
struct BoundFiles {
    report: String,
    result: String,
    review: String,
    plan: String,
}

pub(super) fn read(
    directory: &Path,
    availability: ReadAvailability,
) -> Result<Option<PlannedTaskMemoryReport>, WorkRecordReadError> {
    // Passthrough: the binding document is checked field by field and its
    // raw values are hashed into the source revision.
    let Some(binding) = read::json(&directory.join("memory-report-binding.json"), availability)?
    else {
        return Ok(None);
    };
    if binding.get("schema").and_then(Value::as_str) != Some("butler.planned-task-memory-report.v1")
    {
        return Ok(None);
    }
    let files = bound_files(directory, &binding, availability)?;
    let current = read::snapshot(directory, availability)?;
    // Source computes disposition before the rejection chain. Invalid review
    // shapes therefore remain errors rather than healthy missing reports.
    let disposition = current
        .as_ref()
        .and_then(|current| current.review.as_ref())
        .and_then(read::ReviewFile::document)
        .map(current_disposition)
        .transpose()?;
    let (Some(files), Some(current)) = (files, current) else {
        return Ok(None);
    };
    if !hashes_match(&binding, &files)
        || !latest_attempt_matches(&binding, &current)
        || !record_matches(&binding)?
        || !review_accepted(&binding, &current)?
        || !disposition_matches(&binding, &current, disposition)
        || !revision_matches(&binding)?
    {
        return Ok(None);
    }
    let mut output: PlannedTaskMemoryReport = serde_json::from_value(binding)?;
    output.text = files.report;
    Ok(Some(output))
}

/// The public report, the bound attempt's result, and the review and plan
/// texts; `None` when any is missing.
fn bound_files(
    directory: &Path,
    binding: &Value,
    availability: ReadAvailability,
) -> Result<Option<BoundFiles>, WorkRecordReadError> {
    let report = read::text(&directory.join("public-report.md"), availability)?;
    let attempt_name = binding
        .get("attempt")
        .map(js_string)
        .unwrap_or_else(|| "undefined".into());
    let attempt_name = format!("{attempt_name:0>3}");
    let result = read::text(
        &directory
            .join("attempts")
            .join(attempt_name)
            .join("result.md"),
        availability,
    )?;
    let review = read::text(&directory.join("review.json"), availability)?;
    let plan = read::text(&directory.join("plan.json"), availability)?;
    Ok(match (report, result, review, plan) {
        (Some(report), Some(result), Some(review), Some(plan)) => Some(BoundFiles {
            report,
            result,
            review,
            plan,
        }),
        _ => None,
    })
}

fn hashes_match(binding: &Value, files: &BoundFiles) -> bool {
    [
        (&files.report, "report_hash"),
        (&files.result, "result_hash"),
        (&files.review, "review_hash"),
        (&files.plan, "plan_hash"),
    ]
    .into_iter()
    .all(|(text, key)| binding.get(key).and_then(Value::as_str) == Some(hash(text).as_str()))
}

/// The binding's attempt is the task's latest (whole-numbered) attempt.
fn latest_attempt_matches(binding: &Value, current: &Snapshot) -> bool {
    let latest = current
        .latest_attempt
        .as_deref()
        .map(butler_core::json::number_from_string)
        .unwrap_or(f64::NAN);
    latest.is_finite()
        && latest.fract() == 0.0
        && Some(latest) == binding.get("attempt").and_then(Value::as_f64)
}

/// The binding names the task's memory record.
fn record_matches(binding: &Value) -> Result<bool, WorkRecordReadError> {
    let task_id = binding
        .get("task_id")
        .and_then(Value::as_str)
        .ok_or(WorkRecordReadError::Malformed)?;
    Ok(binding.get("record_id").and_then(Value::as_str)
        == Some(super::task_memory_record_id(task_id).as_str()))
}

/// A non-null review of the bound attempt that verified its memory source,
/// reviewed the plan's goal, lists no missing evidence, covers every
/// acceptance criterion, and gives evidence for every passed criterion.
fn review_accepted(binding: &Value, current: &Snapshot) -> Result<bool, WorkRecordReadError> {
    let Some(review) = current.review.as_ref().and_then(read::ReviewFile::document) else {
        return Ok(false);
    };
    if review.attempt.valid().copied() != binding.get("attempt").and_then(Value::as_f64)
        || review.memory_source_verified != Arg::Valid(true)
    {
        return Ok(false);
    }
    let goal_review = match &review.goal_review {
        Arg::Missing | Arg::Null | Arg::Invalid(_) => return Err(WorkRecordReadError::Malformed),
        Arg::Valid(Obj(goal_review)) => goal_review,
    };
    if trim(required(&goal_review.goal)?) != plan_goal(&current.plan)? {
        return Ok(false);
    }
    let missing_evidence = review
        .missing_evidence
        .valid()
        .ok_or(WorkRecordReadError::Malformed)?;
    if !missing_evidence.is_empty() {
        return Ok(false);
    }
    let criteria = criteria(review)?;
    if missing_criteria(&current.plan, &criteria)? {
        return Ok(false);
    }
    for criterion in &criteria {
        if criterion
            .and_then(|c| c.verdict.valid())
            .map(String::as_str)
            == Some("PASS")
            && trim(required(criterion.map_or(&Arg::Missing, |c| &c.evidence))?).is_empty()
        {
            return Ok(false);
        }
    }
    Ok(true)
}

/// The plan's internal goal, or its goal when that is empty.
fn plan_goal(plan: &PlanRecord) -> Result<&str, WorkRecordReadError> {
    let internal_goal = match &plan.internal_goal {
        Arg::Missing | Arg::Null => "",
        Arg::Valid(goal) => trim(goal),
        Arg::Invalid(_) => return Err(WorkRecordReadError::Malformed),
    };
    if internal_goal.is_empty() {
        Ok(trim(required(&plan.goal)?))
    } else {
        Ok(internal_goal)
    }
}

/// The review's criteria; an item that is not an object reads as `None`.
fn criteria(review: &ReviewRecord) -> Result<Vec<Option<&CriterionReview>>, WorkRecordReadError> {
    Ok(review
        .criteria
        .valid()
        .ok_or(WorkRecordReadError::Malformed)?
        .iter()
        .map(|item| item.valid().map(|Obj(criterion)| criterion))
        .collect())
}

/// The task's state and the bound disposition agree with the review.
fn disposition_matches(binding: &Value, current: &Snapshot, disposition: Option<&str>) -> bool {
    if !matches!(
        current.status.as_str(),
        "PUBLIC_REPORT_READY" | "FAILED_PUBLIC_REPORT_READY" | "REPORTED"
    ) {
        return false;
    }
    let bound = binding.get("disposition").and_then(Value::as_str);
    disposition == bound
        && !(current.status == "PUBLIC_REPORT_READY" && bound != Some("succeeded"))
        && !(current.status == "FAILED_PUBLIC_REPORT_READY" && bound == Some("succeeded"))
}

/// The binding's source revision hashes its own identity fields.
fn revision_matches(binding: &Value) -> Result<bool, WorkRecordReadError> {
    let field = |key: &str| binding.get(key).unwrap_or(&Value::Null);
    let revision = crate::js_json::stringify(&(
        "planned-task-memory-report",
        field("task_id"),
        field("attempt"),
        field("result_hash"),
        field("review_hash"),
        field("plan_hash"),
        field("report_hash"),
        field("disposition"),
    ))?;
    Ok(binding.get("source_revision").and_then(Value::as_str) == Some(hash(&revision).as_str()))
}

/// `succeeded` when the review, its goal review and every criterion passed;
/// `failed` for a failed review; `partial` otherwise.
fn current_disposition(review: &ReviewRecord) -> Result<&'static str, WorkRecordReadError> {
    let verdict = review.verdict.valid().map(String::as_str);
    if verdict == Some("PASS") {
        let goal_verdict = match &review.goal_review {
            Arg::Missing | Arg::Null => return Err(WorkRecordReadError::Malformed),
            Arg::Valid(Obj(goal)) => goal.verdict.valid().map(String::as_str),
            Arg::Invalid(_) => None,
        };
        if goal_verdict == Some("PASS")
            && criteria(review)?.iter().all(|criterion| {
                criterion
                    .and_then(|c| c.verdict.valid())
                    .map(String::as_str)
                    == Some("PASS")
            })
        {
            return Ok("succeeded");
        }
    }
    Ok(if verdict == Some("FAIL") {
        "failed"
    } else {
        "partial"
    })
}

/// Whether a non-blank acceptance criterion has no review (by index or by
/// case-insensitive text).
fn missing_criteria(
    plan: &PlanRecord,
    reviews: &[Option<&CriterionReview>],
) -> Result<bool, WorkRecordReadError> {
    let acceptance = plan
        .acceptance_criteria
        .valid()
        .ok_or(WorkRecordReadError::Malformed)?;
    let reviewed = reviews
        .iter()
        .map(|review| {
            Ok(trim(required(review.map_or(&Arg::Missing, |r| &r.criterion))?).to_lowercase())
        })
        .collect::<Result<std::collections::HashSet<_>, WorkRecordReadError>>()?;
    for (index, criterion) in acceptance.iter().enumerate() {
        let criterion = trim(required(criterion)?);
        if criterion.is_empty() {
            continue;
        }
        let by_index = reviews.iter().any(|review| {
            review.and_then(|r| r.criterion_index.valid()).copied() == Some((index + 1) as f64)
        });
        if !by_index && !reviewed.contains(&criterion.to_lowercase()) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// A string field the record must have.
fn required(value: &Arg<String>) -> Result<&str, WorkRecordReadError> {
    value
        .valid()
        .map(String::as_str)
        .ok_or(WorkRecordReadError::Malformed)
}
fn hash(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}
/// JavaScript `String(value)` of the binding's attempt, used as the attempt
/// directory name.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        Value::Object(_) => "[object Object]".into(),
        Value::Array(values) => values
            .iter()
            .map(|value| {
                if value.is_null() {
                    String::new()
                } else {
                    js_string(value)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        value => butler_core::json::stringify(value).unwrap_or_default(),
    }
}
