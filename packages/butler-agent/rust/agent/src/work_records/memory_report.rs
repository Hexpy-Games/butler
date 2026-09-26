use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::read::{self, ReadAvailability, WorkRecordReadError};
use crate::public_text::trim_js_whitespace as trim;

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

pub(super) fn read(
    directory: &Path,
    availability: ReadAvailability,
) -> Result<Option<PlannedTaskMemoryReport>, WorkRecordReadError> {
    let Some(binding) = read::json(&directory.join("memory-report-binding.json"), availability)?
    else {
        return Ok(None);
    };
    if binding.get("schema").and_then(Value::as_str) != Some("butler.planned-task-memory-report.v1")
    {
        return Ok(None);
    }
    let report = read::text(&directory.join("public-report.md"), availability)?;
    let attempt = binding.get("attempt").and_then(Value::as_f64);
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
    let current = read::snapshot(directory, availability)?;
    // Source computes disposition before the rejection chain. Invalid review
    // shapes therefore remain errors rather than healthy missing reports.
    let disposition = current
        .as_ref()
        .and_then(|current| current.review.as_ref())
        .filter(|review| !review.is_null())
        .map(current_disposition)
        .transpose()?;
    let (Some(report), Some(result), Some(review), Some(plan), Some(current)) =
        (report, result, review, plan, current)
    else {
        return Ok(None);
    };
    for (text, key) in [
        (&report, "report_hash"),
        (&result, "result_hash"),
        (&review, "review_hash"),
        (&plan, "plan_hash"),
    ] {
        if binding.get(key).and_then(Value::as_str) != Some(hash(text).as_str()) {
            return Ok(None);
        }
    }
    let latest = current
        .latest_attempt
        .as_deref()
        .map(crate::json::number_from_string)
        .unwrap_or(f64::NAN);
    if !latest.is_finite() || latest.fract() != 0.0 || Some(latest) != attempt {
        return Ok(None);
    }
    let task_id = string(&binding, "task_id")?;
    if binding.get("record_id").and_then(Value::as_str)
        != Some(super::task_memory_record_id(task_id).as_str())
    {
        return Ok(None);
    }
    let Some(review) = current.review.as_ref().filter(|review| !review.is_null()) else {
        return Ok(None);
    };
    if review.get("attempt").and_then(Value::as_f64) != attempt
        || review.get("memory_source_verified") != Some(&Value::Bool(true))
    {
        return Ok(None);
    }
    let goal_review = review.get("goal_review").ok_or(WorkRecordReadError)?;
    let internal_goal = match current.plan.get("internal_goal") {
        None | Some(Value::Null) => "",
        Some(value) => trim(value.as_str().ok_or(WorkRecordReadError)?),
    };
    let internal_goal = if internal_goal.is_empty() {
        trim(string(&current.plan, "goal")?)
    } else {
        internal_goal
    };
    if trim(string(goal_review, "goal")?) != internal_goal {
        return Ok(None);
    }
    if !array(review, "missing_evidence")?.is_empty() {
        return Ok(None);
    }
    let criteria = array(review, "criteria")?;
    if missing_criteria(&current.plan, criteria)? {
        return Ok(None);
    }
    for criterion in criteria {
        if criterion.get("verdict").and_then(Value::as_str) == Some("PASS")
            && trim(string(criterion, "evidence")?).is_empty()
        {
            return Ok(None);
        }
    }
    if !matches!(
        current.status.as_str(),
        "PUBLIC_REPORT_READY" | "FAILED_PUBLIC_REPORT_READY" | "REPORTED"
    ) {
        return Ok(None);
    }
    let binding_disposition = binding.get("disposition").and_then(Value::as_str);
    if disposition != binding_disposition
        || (current.status == "PUBLIC_REPORT_READY" && binding_disposition != Some("succeeded"))
        || (current.status == "FAILED_PUBLIC_REPORT_READY"
            && binding_disposition == Some("succeeded"))
    {
        return Ok(None);
    }
    let revision = json!([
        "planned-task-memory-report",
        binding["task_id"],
        binding["attempt"],
        binding["result_hash"],
        binding["review_hash"],
        binding["plan_hash"],
        binding["report_hash"],
        binding["disposition"]
    ]);
    let revision = crate::json::stringify(&revision).map_err(|_| WorkRecordReadError)?;
    if binding.get("source_revision").and_then(Value::as_str) != Some(hash(&revision).as_str()) {
        return Ok(None);
    }
    let mut output: PlannedTaskMemoryReport =
        serde_json::from_value(binding).map_err(|_| WorkRecordReadError)?;
    output.text = report;
    Ok(Some(output))
}

fn current_disposition(review: &Value) -> Result<&'static str, WorkRecordReadError> {
    let verdict = review.get("verdict").and_then(Value::as_str);
    if verdict == Some("PASS") {
        let goal = review
            .get("goal_review")
            .filter(|value| !value.is_null())
            .ok_or(WorkRecordReadError)?;
        if goal.get("verdict").and_then(Value::as_str) == Some("PASS")
            && array(review, "criteria")?
                .iter()
                .all(|criterion| criterion.get("verdict").and_then(Value::as_str) == Some("PASS"))
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

fn missing_criteria(plan: &Value, reviews: &[Value]) -> Result<bool, WorkRecordReadError> {
    let acceptance = array(plan, "acceptance_criteria")?;
    let reviewed = reviews
        .iter()
        .map(|review| Ok(trim(string(review, "criterion")?).to_lowercase()))
        .collect::<Result<std::collections::HashSet<_>, WorkRecordReadError>>()?;
    for (index, criterion) in acceptance.iter().enumerate() {
        let criterion = trim(criterion.as_str().ok_or(WorkRecordReadError)?);
        if criterion.is_empty() {
            continue;
        }
        let by_index = reviews.iter().any(|review| {
            review.get("criterion_index").and_then(Value::as_f64) == Some((index + 1) as f64)
        });
        if !by_index && !reviewed.contains(&criterion.to_lowercase()) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str, WorkRecordReadError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or(WorkRecordReadError)
}
fn array<'a>(value: &'a Value, key: &str) -> Result<&'a Vec<Value>, WorkRecordReadError> {
    value
        .get(key)
        .and_then(Value::as_array)
        .ok_or(WorkRecordReadError)
}
fn hash(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}
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
        value => crate::json::stringify(value).unwrap_or_default(),
    }
}
