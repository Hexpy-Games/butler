use serde_json::Value;

use super::{js_truthy, subsession};
use crate::btcc::BtccError;
use crate::btcc::{TurnRequest, TurnTrigger};
use crate::conversation::{
    ConversationLocaleCollation, ConversationOriginDecision, ConversationOriginEvidence,
    ConversationOriginFacts, classify_conversation_origin,
};
use crate::workspace::{SessionRole, StoredSessionBinding};

pub(super) fn resolve(
    collation: &dyn ConversationLocaleCollation,
    binding: &StoredSessionBinding,
    request: &TurnRequest,
) -> Result<ConversationOriginDecision, BtccError> {
    let subsession = subsession::read(binding)?.is_some();
    let metadata = binding.metadata.as_ref();
    let subsession_result = request
        .execution_controls
        .as_ref()
        .map(crate::btcc::execution_controls::ExecutionControls::verify)
        .transpose()?
        .is_some_and(|value| value.subsession_result.is_some());
    let authority = authority_ref(request);
    let role_internal = matches!(binding.role, SessionRole::Worker | SessionRole::Steward);
    let native_steward = metadata
        .and_then(|value| value.get("nativeStewardContext"))
        .is_some_and(js_truthy);
    let wake = matches!(request.trigger, TurnTrigger::AuthorizedWake { .. });
    let internal = role_internal
        || subsession
        || native_steward
        || subsession_result
        || authority.is_some()
        || wake;
    let reference = format!("btcc:{}:{}", request.turn_id, request.message.id);
    let mut evidence = Vec::new();
    if !internal {
        evidence.push(item("btcc_admission", &reference));
    }
    if role_internal || subsession || native_steward || subsession_result {
        evidence.push(item("subsession", &reference));
    }
    if let TurnTrigger::AuthorizedWake { trigger_id, .. } = &request.trigger {
        evidence.push(item("authorized_wake", trigger_id));
    }
    if let Some(authority) = authority {
        evidence.push(item("authority_continuation", authority));
    }
    Ok(classify_conversation_origin(
        collation,
        ConversationOriginFacts {
            reference: Some(reference),
            public_ingress: !internal,
            internal_control: internal,
            evidence_available: true,
            evidence,
        },
    ))
}

fn authority_ref(request: &TurnRequest) -> Option<&str> {
    let app = request
        .app_turn_context
        .as_ref()
        .and_then(Value::as_object)
        .and_then(|value| value.get("authorityRequestRef"));
    match app {
        Some(Value::Null) | None => request
            .authority_request_ref
            .as_deref()
            .filter(|v| !v.is_empty()),
        Some(Value::String(value)) if !value.is_empty() => Some(value),
        _ => None,
    }
}
fn item(kind: &str, reference: &str) -> ConversationOriginEvidence {
    ConversationOriginEvidence {
        reference: reference.into(),
        kind: kind.into(),
        sha256: None,
    }
}
