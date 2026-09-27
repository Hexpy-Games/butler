//! Read-only task facts needed to publish reviewed outcome memory.

use serde_json::Value;

use super::{
    PlannedTaskMemoryReport, ReadAvailability, WorkRecordReadError, WorkRecordReader, read,
};

#[derive(Debug)]
pub(crate) struct TaskMemoryProjection {
    pub report: PlannedTaskMemoryReport,
    pub request: Option<String>,
    pub origin_task_summary: Option<String>,
    pub origin_session_id: Option<String>,
    pub origin_event_id: Option<String>,
    pub plan_origin_session_id: Option<String>,
    pub plan_origin_event_id: Option<String>,
}

pub(super) fn read(
    reader: &WorkRecordReader,
    task_id: &str,
) -> Result<Option<TaskMemoryProjection>, WorkRecordReadError> {
    let directory = reader.tasks.join(task_id);
    let Some(report) = reader.read_memory_report(task_id, ReadAvailability::Strict)? else {
        return Ok(None);
    };
    let Some(snapshot) = read::snapshot(&directory, ReadAvailability::Strict)? else {
        return Ok(None);
    };
    let Some(review) = snapshot.review.as_ref() else {
        return Ok(None);
    };
    if !matches!(
        snapshot.status.as_str(),
        "PUBLIC_REPORT_READY" | "FAILED_PUBLIC_REPORT_READY" | "REPORTED"
    ) || review["attempt"].as_f64() != Some(report.attempt)
        || snapshot.plan["project"].as_str() != Some(report.project_id.as_str())
    {
        return Ok(None);
    }
    let public_report = read::text(
        &directory.join("public-report.md"),
        ReadAvailability::Strict,
    )?
    .unwrap_or_default();
    if crate::public_text::trim_js_whitespace(&public_report).is_empty() {
        return Ok(None);
    }
    let request = read::text(&directory.join("request.md"), ReadAvailability::BestEffort)?
        .map(|value| crate::public_text::trim_js_whitespace(&value).to_owned())
        .filter(|value| !value.is_empty());
    let origin = read::json(&directory.join("origin.json"), ReadAvailability::BestEffort)?
        .filter(valid_origin);
    Ok(Some(TaskMemoryProjection {
        report,
        request,
        origin_task_summary: origin
            .as_ref()
            .and_then(|value| value.get("task_summary"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        origin_session_id: origin
            .as_ref()
            .and_then(|value| value.get("origin_session_id"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        origin_event_id: origin
            .as_ref()
            .and_then(|value| value.get("origin_inbound_event_id"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        plan_origin_session_id: snapshot
            .plan
            .get("origin_session_id")
            .and_then(Value::as_str)
            .map(str::to_owned),
        plan_origin_event_id: snapshot
            .plan
            .get("origin_event_id")
            .and_then(Value::as_str)
            .map(str::to_owned),
    }))
}

fn valid_origin(origin: &Value) -> bool {
    origin["version"].as_i64() == Some(1)
        && origin["origin_session_id"].is_string()
        && origin["task_summary"].is_string()
        && origin
            .pointer("/transcript_ref/path")
            .is_some_and(Value::is_string)
}
