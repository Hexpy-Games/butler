//! Read-only task facts needed to publish reviewed outcome memory.

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
    let review_attempt = review
        .document()
        .and_then(|review| review.attempt.valid().copied());
    if !matches!(
        snapshot.status.as_str(),
        "PUBLIC_REPORT_READY" | "FAILED_PUBLIC_REPORT_READY" | "REPORTED"
    ) || review_attempt != Some(report.attempt)
        || snapshot.plan.project.valid() != Some(&report.project_id)
    {
        return Ok(None);
    }
    let public_report = read::text(
        &directory.join("public-report.md"),
        ReadAvailability::Strict,
    )?
    .unwrap_or_default();
    if butler_core::public_text::trim_js_whitespace(&public_report).is_empty() {
        return Ok(None);
    }
    let request = read::text(&directory.join("request.md"), ReadAvailability::BestEffort)?
        .map(|value| butler_core::public_text::trim_js_whitespace(&value).to_owned())
        .filter(|value| !value.is_empty());
    let origin = read::json(&directory.join("origin.json"), ReadAvailability::BestEffort)?
        .map(|value| crate::lenient::view::<read::Origin>(&value))
        .filter(read::Origin::valid)
        .unwrap_or_default();
    Ok(Some(TaskMemoryProjection {
        report,
        request,
        origin_task_summary: origin.task_summary,
        origin_session_id: origin.origin_session_id,
        origin_event_id: origin.origin_inbound_event_id,
        plan_origin_session_id: snapshot.plan.origin_session_id.valid().cloned(),
        plan_origin_event_id: snapshot.plan.origin_event_id.valid().cloned(),
    }))
}
