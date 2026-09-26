use super::super::{invalid, required_string};
use super::common::*;
use crate::project_ledger::ProjectLedgerReadError;
use serde_json::Value;

pub(in crate::project_ledger::dashboard::managed) fn manifest(
    value: &Value,
) -> Result<(), ProjectLedgerReadError> {
    let origin = object(value.get("origin"))?;
    exact(origin, &["turnId", "messageId"], &[])?;
    required_string(value.get("origin").ok_or_else(invalid)?, "turnId")?;
    required_string(value.get("origin").ok_or_else(invalid)?, "messageId")?;
    identity(value.get("operationIdentity").ok_or_else(invalid)?)?;
    digest(value.get("materialFingerprint"))?;
    if let Some(stage) = value.get("currentStage") {
        stage_value(stage)?;
    }
    let stages = array(value.get("allowedNextStages"))?;
    for stage in stages {
        stage_value(stage)?;
    }
    for name in ["createdAt", "updatedAt"] {
        required_string(value, name)?;
    }
    for name in [
        "currentPlanRevisionId",
        "latestCheckpointRevisionId",
        "latestPlanReviewRevisionId",
        "latestResultReviewRevisionId",
        "latestCompletionValidationRevisionId",
        "latestDispositionRevisionId",
    ] {
        if value.get(name).is_some() {
            required_string(value, name)?;
        }
    }
    let progress = array(value.get("actionProgress"))?;
    for item in progress {
        progress_value(item)?;
    }
    for result in array(value.get("resultRefs"))? {
        let record = object(Some(result))?;
        exact(
            record,
            &[
                "resultRef",
                "toolCallId",
                "toolName",
                "status",
                "originTurnId",
                "attachedAt",
            ],
            &["resultSha256", "errorCode"],
        )?;
        for name in [
            "resultRef",
            "toolCallId",
            "toolName",
            "originTurnId",
            "attachedAt",
        ] {
            required_string(result, name)?;
        }
        if result.get("status").and_then(Value::as_str) != Some("completed")
            || result.get("errorCode").is_some()
        {
            return Err(invalid());
        }
        digest(result.get("resultSha256"))?;
    }
    for binding in array(value.get("bindingRefs"))? {
        exact(
            object(Some(binding))?,
            &["bindingRevisionId", "turnId", "revision"],
            &[],
        )?;
        required_string(binding, "bindingRevisionId")?;
        required_string(binding, "turnId")?;
        if binding
            .get("revision")
            .and_then(Value::as_u64)
            .is_none_or(|value| value == 0)
        {
            return Err(invalid());
        }
    }
    if value.get("reviewRevision").and_then(Value::as_u64) == Some(0)
        && [
            "latestPlanReviewRevisionId",
            "latestResultReviewRevisionId",
            "latestCompletionValidationRevisionId",
        ]
        .iter()
        .any(|name| value.get(*name).is_some())
    {
        return Err(invalid());
    }
    Ok(())
}
