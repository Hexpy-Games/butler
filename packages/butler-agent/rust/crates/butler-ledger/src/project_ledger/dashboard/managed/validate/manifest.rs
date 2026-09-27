use super::super::{invalid, required_string};
use super::common::*;
use crate::project_ledger::ProjectLedgerReadError;
use serde_json::Value;

/// The manifest's nested values: origin, identity, stages, pointers,
/// progress, result and binding references, and review pointers only once a
/// review exists.
pub(in crate::project_ledger::dashboard::managed) fn manifest(
    value: &Value,
) -> Result<(), ProjectLedgerReadError> {
    let origin = value.get("origin").ok_or_else(invalid)?;
    exact(object(Some(origin))?, &["turnId", "messageId"], &[])?;
    required_string(origin, "turnId")?;
    required_string(origin, "messageId")?;
    identity(value.get("operationIdentity").ok_or_else(invalid)?)?;
    digest(value.get("materialFingerprint"))?;
    if let Some(stage) = value.get("currentStage") {
        stage_value(stage)?;
    }
    for stage in array(value.get("allowedNextStages"))? {
        stage_value(stage)?;
    }
    for name in ["createdAt", "updatedAt"] {
        required_string(value, name)?;
    }
    for name in REVISION_POINTERS {
        if value.get(name).is_some() {
            required_string(value, name)?;
        }
    }
    for item in array(value.get("actionProgress"))? {
        progress_value(item)?;
    }
    for result in array(value.get("resultRefs"))? {
        result_ref(result)?;
    }
    for binding in array(value.get("bindingRefs"))? {
        binding_ref(binding)?;
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

const REVISION_POINTERS: [&str; 6] = [
    "currentPlanRevisionId",
    "latestCheckpointRevisionId",
    "latestPlanReviewRevisionId",
    "latestResultReviewRevisionId",
    "latestCompletionValidationRevisionId",
    "latestDispositionRevisionId",
];

/// A completed tool result reference.
fn result_ref(result: &Value) -> Result<(), ProjectLedgerReadError> {
    exact(
        object(Some(result))?,
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
    digest(result.get("resultSha256"))
}

/// A Turn binding reference with a positive revision.
fn binding_ref(binding: &Value) -> Result<(), ProjectLedgerReadError> {
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
    Ok(())
}
