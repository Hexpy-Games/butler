use serde_json::{Map, Value};

use super::contracts::{DeliveryOutbox, DeliveryStatus, FinalPayload, TurnRecord, TurnTransition};
use super::failure::runtime_failure_message;
use crate::btcc::BtccError;
use crate::btcc::identity::{content_ref, digest};

pub(super) fn guided_final(
    turn: &TurnRecord,
    result: super::contracts::AgentLoopResult,
) -> Result<TurnTransition, BtccError> {
    let content = if result.terminal_outcome == Some(super::contracts::TerminalOutcome::NoVisible) {
        String::new()
    } else {
        let trimmed = crate::public_text::trim_js_whitespace(&result.content);
        if trimmed.is_empty() {
            runtime_failure_message(
                &turn.original_message,
                &crate::btcc::RuntimeFailure {
                    code: "runtime_error".into(),
                    retryable: false,
                },
            )
        } else {
            trimmed.to_owned()
        }
    };
    let content_sha256 = digest(&content);
    let mut body = Map::new();
    body.insert("turnId".into(), Value::String(turn.turn_id.clone()));
    body.insert(
        "contentSha256".into(),
        Value::String(content_sha256.clone()),
    );
    body.insert("route".into(), serde_json::to_value(result.route).unwrap());
    body.insert("disposition".into(), Value::String("completed".into()));
    body.insert("content".into(), Value::String(content.clone()));
    if let Some(value) = &result.work_status {
        body.insert("workStatus".into(), serde_json::to_value(value).unwrap());
    }
    if let Some(value) = &result.accepted_work_result {
        body.insert(
            "acceptedWorkResult".into(),
            serde_json::to_value(value).unwrap(),
        );
    }
    if let Some(value) = &result.runtime_failure {
        body.insert(
            "runtimeFailure".into(),
            serde_json::to_value(value).unwrap(),
        );
    }
    if !result.artifacts.is_empty() {
        body.insert(
            "artifacts".into(),
            serde_json::to_value(&result.artifacts).unwrap(),
        );
    }
    if !result.changed_files.is_empty() {
        body.insert(
            "changedFiles".into(),
            Value::Array(result.changed_files.clone()),
        );
    }
    if let Some(value) = &result.plan {
        body.insert("plan".into(), value.clone());
    }
    if let Some(value) = &result.model_identity {
        body.insert("modelIdentity".into(), serde_json::to_value(value).unwrap());
    }
    let reference = content_ref("payload", &Value::Object(body))?;
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
        plan: result.plan,
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
