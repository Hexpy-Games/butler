use serde_json::{Map, Value};

use super::contracts::{DeliveryOutbox, DeliveryStatus, FinalPayload, TurnRecord, TurnTransition};
use super::failure::runtime_failure_message;
use crate::btcc::BtccError;
use crate::btcc::identity::{content_ref, digest, json_value};

/// Accepts the agent's final answer: the payload (content-addressed by its
/// body digest) and the Outbox that delivers it as the canonical message.
pub(super) fn guided_final(
    turn: &TurnRecord,
    result: super::contracts::AgentLoopResult,
) -> Result<TurnTransition, BtccError> {
    let content = final_content(turn, &result);
    let content_sha256 = digest(&content);
    let reference = content_ref(
        "payload",
        &payload_body(turn, &result, &content, &content_sha256)?,
    )?;
    let outbox_id = digest(&format!(
        "btcc-canonical-delivery.v1\0{}\0{}\0{}",
        turn.turn_id,
        turn.revision + 1,
        reference.sha256
    ));
    let payload = FinalPayload {
        reference: reference.clone(),
        turn_id: turn.turn_id.clone(),
        route: result.route,
        disposition: super::contracts::FinalDisposition::Completed,
        content_sha256,
        content: content.clone(),
        work_status: result.work_status,
        accepted_work_result: result.accepted_work_result,
        runtime_failure: result.runtime_failure,
        artifacts: result.artifacts,
        changed_files: result.changed_files,
        plan: None,
        model_identity: result.model_identity,
        execution_outcome: None,
        extensions: Map::new(),
    };
    Ok(TurnTransition::AcceptFinal {
        route: result.route,
        payload: Box::new(payload),
        outbox: Box::new(DeliveryOutbox {
            outbox_id: outbox_id.clone(),
            final_payload_ref: reference,
            expected_message_id: digest(&format!("btcc-assistant-message.v1\0{outbox_id}")),
            content,
            status: DeliveryStatus::Pending,
        }),
    })
}

/// The delivered content: empty for a no-visible terminal outcome, the
/// trimmed answer, or the runtime-error message when the answer is blank.
fn final_content(turn: &TurnRecord, result: &super::contracts::AgentLoopResult) -> String {
    if result.terminal_outcome == Some(super::contracts::TerminalOutcome::NoVisible) {
        return String::new();
    }
    let trimmed = butler_core::public_text::trim_js_whitespace(&result.content);
    if !trimmed.is_empty() {
        return trimmed.to_owned();
    }
    runtime_failure_message(
        &turn.original_message,
        &crate::btcc::RuntimeFailure {
            code: "runtime_error".into(),
            retryable: false,
        },
    )
}

/// The digested payload body. Its key order and omissions determine the
/// payload reference and outbox id, so they are part of the stored format.
fn payload_body(
    turn: &TurnRecord,
    result: &super::contracts::AgentLoopResult,
    content: &str,
    content_sha256: &str,
) -> Result<Value, BtccError> {
    let mut body = Map::new();
    body.insert("turnId".into(), Value::String(turn.turn_id.clone()));
    body.insert("contentSha256".into(), Value::String(content_sha256.into()));
    body.insert("route".into(), json_value(&result.route)?);
    body.insert("disposition".into(), Value::String("completed".into()));
    body.insert("content".into(), Value::String(content.into()));
    if let Some(value) = &result.work_status {
        body.insert("workStatus".into(), json_value(value)?);
    }
    if let Some(value) = &result.accepted_work_result {
        body.insert("acceptedWorkResult".into(), json_value(value)?);
    }
    if let Some(value) = &result.runtime_failure {
        body.insert("runtimeFailure".into(), json_value(value)?);
    }
    if !result.artifacts.is_empty() {
        body.insert("artifacts".into(), json_value(&result.artifacts)?);
    }
    if !result.changed_files.is_empty() {
        body.insert("changedFiles".into(), json_value(&result.changed_files)?);
    }
    if let Some(value) = &result.model_identity {
        body.insert("modelIdentity".into(), json_value(value)?);
    }
    Ok(Value::Object(body))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::btcc::{ChangedFileLine, ChangedFileSummary, ChangedLineKind, TurnSemanticState};

    /// KEEP: the digested final payload body (and so the payload reference
    /// and outbox id) with changed files is byte-stable.
    #[test]
    fn payload_body_with_changed_files_is_byte_stable() {
        let turn =
            super::super::test_support::record("turn-1", "session-1", TurnSemanticState::Admitted);
        let mut result = super::super::test_support::agent_result();
        result.changed_files = vec![ChangedFileSummary {
            path: "src/a.rs".into(),
            additions: 1,
            deletions: 1,
            lines: vec![
                ChangedFileLine {
                    kind: ChangedLineKind::Deleted,
                    content: "old".into(),
                    old_line: Some(3),
                    new_line: None,
                },
                ChangedFileLine {
                    kind: ChangedLineKind::Added,
                    content: "new".into(),
                    old_line: None,
                    new_line: Some(3),
                },
            ],
        }];
        let body = payload_body(&turn, &result, "done", "sha").unwrap();
        assert_eq!(
            butler_core::json::stringify(&body).unwrap(),
            r#"{"turnId":"turn-1","contentSha256":"sha","route":"direct","disposition":"completed","content":"done","changedFiles":[{"path":"src/a.rs","additions":1,"deletions":1,"lines":[{"type":"deleted","content":"old","old_line":3},{"type":"added","content":"new","new_line":3}]}]}"#
        );
    }
}
