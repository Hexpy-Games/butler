use super::super::{invalid, required_string};
use super::common::*;
use crate::project_ledger::ProjectLedgerReadError;
use serde_json::Value;

pub(in crate::project_ledger::dashboard::managed) fn child(
    value: &Value,
    property: &str,
) -> Result<(), ProjectLedgerReadError> {
    identity(value.get("operationIdentity").ok_or_else(invalid)?)?;
    let item = value.get(property).ok_or_else(invalid)?;
    let record = object(Some(item))?;
    match property {
        "plan" => {
            exact(
                record,
                &[
                    "planRevisionId",
                    "revision",
                    "objective",
                    "actions",
                    "checks",
                    "originTurnId",
                    "createdAt",
                ],
                &["governingRefs", "executionMode"],
            )?;
            positive(item, "revision")?;
            for key in ["objective", "originTurnId", "createdAt"] {
                required_string(item, key)?;
            }
            if let Some(mode) = item.get("executionMode")
                && !matches!(mode.as_str(), Some("direct" | "steward" | "workers"))
            {
                return Err(invalid());
            }
            if let Some(governing) = item.get("governingRefs") {
                strings(governing)?;
            }
            strings(item.get("checks").ok_or_else(invalid)?)?;
            for action in array(item.get("actions"))? {
                let action_record = object(Some(action))?;
                exact(
                    action_record,
                    &["actionKey", "description", "dependencyKeys"],
                    &["effect"],
                )?;
                required_string(action, "actionKey")?;
                required_string(action, "description")?;
                strings(action.get("dependencyKeys").ok_or_else(invalid)?)?;
                if let Some(effect) = action.get("effect") {
                    exact(object(Some(effect))?, &["capability", "target"], &[])?;
                    required_string(effect, "capability")?;
                    required_string(effect, "target")?;
                }
            }
        }
        "checkpoint" => {
            exact(
                record,
                &[
                    "checkpointRevisionId",
                    "revision",
                    "planRevisionId",
                    "stage",
                    "actionProgress",
                    "publicSummary",
                    "nextStep",
                    "referencedResultRefs",
                    "originTurnId",
                    "createdAt",
                ],
                &[],
            )?;
            positive(item, "revision")?;
            stage_value(item.get("stage").ok_or_else(invalid)?)?;
            for key in ["planRevisionId", "originTurnId", "createdAt"] {
                required_string(item, key)?;
            }
            for key in ["publicSummary", "nextStep"] {
                if item
                    .get(key)
                    .and_then(Value::as_str)
                    .is_none_or(|text| text.encode_utf16().count() > 16384)
                {
                    return Err(invalid());
                }
            }
            strings(item.get("referencedResultRefs").ok_or_else(invalid)?)?;
            for progress in array(item.get("actionProgress"))? {
                progress_value(progress)?;
            }
        }
        "review" => {
            exact(
                record,
                &[
                    "reviewRevisionId",
                    "revision",
                    "subject",
                    "verdict",
                    "summary",
                    "corrections",
                    "boundResultRefs",
                    "originTurnId",
                    "createdAt",
                ],
                &[
                    "boundPlanRevisionId",
                    "boundResultReviewRevisionId",
                    "boundActionProgress",
                ],
            )?;
            positive(item, "revision")?;
            if !matches!(
                item.get("subject").and_then(Value::as_str),
                Some("plan" | "result" | "completion")
            ) || !matches!(
                item.get("verdict").and_then(Value::as_str),
                Some("accept" | "revise" | "partial")
            ) {
                return Err(invalid());
            }
            for key in ["summary", "originTurnId", "createdAt"] {
                required_string(item, key)?;
            }
            for key in ["corrections", "boundResultRefs"] {
                strings(item.get(key).ok_or_else(invalid)?)?;
            }
            for key in ["boundPlanRevisionId", "boundResultReviewRevisionId"] {
                if item.get(key).is_some() {
                    required_string(item, key)?;
                }
            }
            if item.get("boundActionProgress").is_some() {
                for progress in array(item.get("boundActionProgress"))? {
                    progress_value(progress)?;
                }
            }
        }
        "disposition" => {
            exact(
                record,
                &[
                    "dispositionRevisionId",
                    "revision",
                    "resultSequence",
                    "materialFingerprint",
                    "runtimeOwnedOpen",
                    "disposition",
                    "summary",
                    "actionUpdates",
                    "remainingActions",
                    "evidenceRefs",
                    "evidenceSnapshot",
                    "followups",
                    "originTurnId",
                    "createdAt",
                ],
                &["nextCondition"],
            )?;
            positive(item, "revision")?;
            if item
                .get("runtimeOwnedOpen")
                .and_then(Value::as_bool)
                .is_none()
                || !matches!(
                    item.get("disposition").and_then(Value::as_str),
                    Some("completed" | "open" | "blocked")
                )
            {
                return Err(invalid());
            }
            digest(item.get("materialFingerprint"))?;
            for key in ["summary", "originTurnId", "createdAt"] {
                required_string(item, key)?;
            }
            for key in [
                "remainingActions",
                "evidenceRefs",
                "evidenceSnapshot",
                "followups",
            ] {
                strings(item.get(key).ok_or_else(invalid)?)?;
            }
            if item.get("nextCondition").is_some() {
                required_string(item, "nextCondition")?;
            }
        }
        "result" => {
            exact(
                record,
                &[
                    "resultRef",
                    "sequence",
                    "toolCallId",
                    "toolName",
                    "status",
                    "originTurnId",
                    "attachedAt",
                ],
                &["resultSha256", "errorCode"],
            )?;
            positive(item, "sequence")?;
            if item.get("status").and_then(Value::as_str) != Some("completed")
                || item.get("errorCode").is_some()
            {
                return Err(invalid());
            }
            for key in ["toolCallId", "toolName", "originTurnId", "attachedAt"] {
                required_string(item, key)?;
            }
            digest(item.get("resultSha256"))?;
        }
        "binding" => {
            exact(
                record,
                &[
                    "bindingRevisionId",
                    "turnId",
                    "sessionId",
                    "revision",
                    "boundAt",
                ],
                &[],
            )?;
            positive(item, "revision")?;
            for key in ["turnId", "sessionId", "boundAt"] {
                required_string(item, key)?;
            }
        }
        _ => return Err(invalid()),
    }
    Ok(())
}
