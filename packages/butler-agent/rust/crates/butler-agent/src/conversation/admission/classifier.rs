use std::collections::HashSet;

use serde_json::{Map, Value};

use super::AdmissionEventVisibility;
use super::sanitizer::safe_tool_content;
use crate::conversation::types::{
    ConversationPartKind, ConversationProviderShape, ConversationRole, ConversationStatus,
    ConversationVisibility,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AdmissionSource {
    Gateway,
    RuntimeTurnEvent,
}

#[derive(Clone, Debug)]
pub(crate) struct ConversationAdmissionInput {
    pub source: AdmissionSource,
    pub kind: String,
    pub role: Option<ConversationRole>,
    pub text: Option<String>,
    pub source_gateway: Option<String>,
    pub source_ref: Option<String>,
    pub payload: Option<Map<String, Value>>,
    pub visibility: Option<AdmissionEventVisibility>,
    pub known_tool_call_ids: HashSet<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub(super) enum AdmissionOperation {
    AppendMessage {
        role: ConversationRole,
        text: String,
        visibility: ConversationVisibility,
        source_gateway: Option<String>,
        source_ref: Option<String>,
    },
    AppendTool {
        kind: ConversationPartKind,
        tool_call_id: String,
        parent_tool_call_id: Option<String>,
        provider_shape: ConversationProviderShape,
        content_json: Value,
        status: ConversationStatus,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct AdmissionDecision {
    pub admitted: bool,
    pub class_name: &'static str,
    pub event_kind: String,
    pub reason: &'static str,
    pub(super) operation: Option<AdmissionOperation>,
}

pub(super) fn classify(input: &ConversationAdmissionInput) -> AdmissionDecision {
    match input.source {
        AdmissionSource::Gateway => gateway(input),
        AdmissionSource::RuntimeTurnEvent => runtime(input),
    }
}
fn gateway(input: &ConversationAdmissionInput) -> AdmissionDecision {
    match (input.kind.as_str(), input.role) {
        ("inbound.accepted", Some(ConversationRole::User)) => {
            message(input, ConversationRole::User, "accepted_user_message")
        }
        ("outbound.final", Some(ConversationRole::Assistant)) => message(
            input,
            ConversationRole::Assistant,
            "final_assistant_message",
        ),
        _ => deny(input, "audit_event", "gateway_event_not_allowlisted"),
    }
}
fn runtime(input: &ConversationAdmissionInput) -> AdmissionDecision {
    if internal(input.kind.as_str()) && input.visibility != Some(AdmissionEventVisibility::Internal)
    {
        return deny(input, "audit_event", "finalized_tool_event_not_internal");
    }
    match input.kind.as_str() {
        "tool_call.finalized" => tool(
            input,
            ConversationPartKind::ToolCall,
            ConversationStatus::Complete,
        ),
        "tool_result.finalized" => tool(
            input,
            ConversationPartKind::ToolResult,
            ConversationStatus::Complete,
        ),
        "tool_result.failed" => tool(
            input,
            ConversationPartKind::ToolResult,
            ConversationStatus::Failed,
        ),
        kind if telemetry(kind) => deny(input, "discarded_telemetry", "telemetry_not_semantic"),
        kind if activity(kind) => deny(input, "activity_state", "turn_activity_not_semantic"),
        _ => deny(input, "audit_event", "unknown_runtime_event_kind"),
    }
}
fn message(
    input: &ConversationAdmissionInput,
    role: ConversationRole,
    reason: &'static str,
) -> AdmissionDecision {
    let Some(text) = input
        .text
        .as_deref()
        .map(crate::public_text::trim_js_whitespace)
        .filter(|v| !v.is_empty())
    else {
        return deny(input, "audit_event", "message_text_missing");
    };
    AdmissionDecision {
        admitted: true,
        class_name: "semantic_message",
        event_kind: input.kind.clone(),
        reason,
        operation: Some(AdmissionOperation::AppendMessage {
            role,
            text: text.into(),
            visibility: ConversationVisibility::Model,
            source_gateway: input.source_gateway.clone(),
            source_ref: input.source_ref.clone(),
        }),
    }
}
fn tool(
    input: &ConversationAdmissionInput,
    kind: ConversationPartKind,
    status: ConversationStatus,
) -> AdmissionDecision {
    let call = input
        .payload
        .as_ref()
        .and_then(|v| v.get("toolCallId"))
        .and_then(Value::as_str)
        .map(crate::public_text::trim_js_whitespace)
        .filter(|v| !v.is_empty());
    let Some(call) = call else {
        return deny(
            input,
            "audit_event",
            if kind == ConversationPartKind::ToolCall {
                "tool_call_id_missing"
            } else {
                "tool_result_call_id_missing"
            },
        );
    };
    if kind == ConversationPartKind::ToolResult && !input.known_tool_call_ids.contains(call) {
        return deny(input, "audit_event", "orphan_tool_result_rejected");
    }
    AdmissionDecision {
        admitted: true,
        class_name: if kind == ConversationPartKind::ToolCall {
            "semantic_tool_call"
        } else {
            "semantic_tool_result"
        },
        event_kind: input.kind.clone(),
        reason: if kind == ConversationPartKind::ToolCall {
            "finalized_tool_call"
        } else {
            "known_tool_result"
        },
        operation: Some(AdmissionOperation::AppendTool {
            kind,
            tool_call_id: call.into(),
            parent_tool_call_id: (kind == ConversationPartKind::ToolResult).then(|| call.into()),
            provider_shape: ConversationProviderShape::Generic,
            content_json: Value::Object(safe_tool_content(input.payload.as_ref(), &input.kind)),
            status,
        }),
    }
}
fn deny(
    input: &ConversationAdmissionInput,
    class_name: &'static str,
    reason: &'static str,
) -> AdmissionDecision {
    AdmissionDecision {
        admitted: false,
        class_name,
        event_kind: input.kind.clone(),
        reason,
        operation: None,
    }
}
fn internal(kind: &str) -> bool {
    matches!(
        kind,
        "tool_call.finalized" | "tool_result.finalized" | "tool_result.failed"
    )
}
fn telemetry(kind: &str) -> bool {
    kind == "model.stream.reasoning_delta"
}
fn activity(kind: &str) -> bool {
    matches!(
        kind,
        "turn.started"
            | "turn.first_progress"
            | "turn.iteration.started"
            | "assistant.decision.delta"
            | "assistant.decision.completed"
            | "model.stream.text_delta"
            | "model.stream.tool_call_delta"
            | "model.stream.completed"
            | "work.block.started"
            | "work.block.updated"
            | "work.block.completed"
            | "assistant.public_note"
            | "tool.started"
            | "tool.progress"
            | "tool.completed"
            | "tool.failed"
            | "guard.started"
            | "guard.completed"
            | "cognition.feedback.captured"
            | "message.final.started"
            | "message.final.delta"
            | "message.final.completed"
            | "turn.observation"
            | "turn.continuation_scheduled"
            | "turn.completed"
            | "turn.failed"
            | "turn.cancelled"
            | "turn.acknowledged"
            | "turn.accepted"
            | "turn.state_changed"
            | "assistant.decision"
            | "tool.invocation.started"
            | "tool.observation.recorded"
            | "completion.evidence.recorded"
            | "completion.reviewed"
            | "turn.outcome"
            | "runtime.fault"
            | "recovery.recorded"
            | "diagnostic.invariant_violation"
    )
}
