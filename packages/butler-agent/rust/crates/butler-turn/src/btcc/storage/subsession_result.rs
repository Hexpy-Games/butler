//! Result outcome comes from the delivered payload, independently of Work.
use serde_json::Value;

pub(super) fn project_delivery(result: &mut Value, payload: &Value) {
    if payload
        .get("content")
        .and_then(Value::as_str)
        .is_none_or(str::is_empty)
        || payload.get("turnId") != result.get("child_turn_id")
        || result["status"] == "cancelled"
    {
        return;
    }
    let status = if payload
        .get("runtimeFailure")
        .is_some_and(|value| !value.is_null())
        || payload["executionOutcome"] == "failed"
    {
        "failed"
    } else {
        "success"
    };
    result["status"] = status.into();
    if let Some(work) = payload.get("workStatus") {
        result["work_status"] = work.clone();
    }
}
