//! Final-result action from accepted BTCC fields and source App metadata.

use serde_json::{Map, Value, json};

use super::{base_metadata, peer};
use crate::{
    btcc::{FinalArtifact, TurnOutcomeKind},
    gateway::ClaimedInboundEvent,
    host::native_ingress::{NativeIngressError, bind::Envelope},
    workspace::SessionTransportBinding,
};

pub(super) struct Terminal<'a> {
    pub(super) text: &'a str,
    canonical: Option<&'a str>,
    turn_id: &'a str,
    kind: &'static str,
    safe_error: Option<&'a str>,
    suspension: Option<&'a str>,
    model: Option<Value>,
    pub(super) artifacts: &'a [FinalArtifact],
    pub(super) changed_files: &'a [Value],
    pub(super) plan: Option<&'a Value>,
}

pub(super) struct RichTerminal {
    pub artifacts: Vec<Value>,
    pub changed_files: Vec<Value>,
    pub plan: Option<Value>,
    pub no_visible: bool,
}

pub(super) fn from_outcome(result: &TurnOutcomeKind) -> Result<Terminal<'_>, NativeIngressError> {
    let terminal = match result {
        TurnOutcomeKind::Delivered(value) => Terminal {
            text: &value.content,
            canonical: Some(&value.message_id),
            turn_id: &value.turn_id,
            kind: if value.runtime_failure.is_some() {
                "turn_failed"
            } else {
                "final_result"
            },
            safe_error: value
                .runtime_failure
                .as_ref()
                .map(|failure| failure.code.as_str()),
            suspension: None,
            model: value
                .model_identity
                .as_ref()
                .and_then(|model| serde_json::to_value(model).ok()),
            artifacts: &value.artifacts,
            changed_files: &value.changed_files,
            plan: value.plan.as_ref(),
        },
        TurnOutcomeKind::AlreadyDelivered(value) => Terminal {
            text: &value.content,
            canonical: Some(&value.message_id),
            turn_id: &value.turn_id,
            kind: if value.runtime_failure.is_some() {
                "turn_failed"
            } else {
                "final_result"
            },
            safe_error: value
                .runtime_failure
                .as_ref()
                .map(|failure| failure.code.as_str()),
            suspension: None,
            model: None,
            artifacts: &value.artifacts,
            changed_files: &value.changed_files,
            plan: None,
        },
        TurnOutcomeKind::Cancelled { turn_id } | TurnOutcomeKind::AlreadyCancelled { turn_id } => {
            cancelled(turn_id)
        }
        TurnOutcomeKind::Suspended { turn_id, reason } => Terminal {
            text: "",
            canonical: None,
            turn_id,
            kind: "turn_suspended",
            safe_error: None,
            suspension: Some(reason),
            model: None,
            artifacts: &[],
            changed_files: &[],
            plan: None,
        },
        TurnOutcomeKind::AlreadyFinalizing { .. }
        | TurnOutcomeKind::FencedPendingPersistence { .. } => {
            return Err(NativeIngressError::new(
                "inbound_turn_recoverable",
                "Turn finalization remains recoverable",
            ));
        }
    };
    Ok(terminal)
}

pub(super) fn cancelled(turn_id: &str) -> Terminal<'_> {
    Terminal {
        text: "",
        canonical: None,
        turn_id,
        kind: "turn_cancelled",
        safe_error: Some("turn_cancelled"),
        suspension: None,
        model: None,
        artifacts: &[],
        changed_files: &[],
        plan: None,
    }
}

pub(super) fn action(
    item: &ClaimedInboundEvent,
    envelope: &Envelope,
    target: &SessionTransportBinding,
    terminal: Terminal<'_>,
    rich: RichTerminal,
) -> Value {
    let RichTerminal {
        artifacts,
        changed_files,
        plan,
        no_visible,
    } = rich;
    let action_id = format!(
        "btcc-final:{}:{}:{}:{}",
        terminal.canonical.unwrap_or(&item.record.queue_id),
        target.transport,
        target.peer_id,
        target.thread_id.as_deref().unwrap_or("main")
    );
    let mut metadata = base_metadata(item, envelope);
    metadata.insert("kind".into(), terminal.kind.into());
    metadata.insert("turnId".into(), terminal.turn_id.into());
    if let Some(canonical) = terminal.canonical {
        metadata.insert("canonicalMessageId".into(), canonical.into());
    }
    if let Some(code) = terminal.safe_error {
        metadata.insert("safeErrorCode".into(), code.into());
    }
    if let Some(reason) = terminal.suspension {
        metadata.insert("suspension".into(), reason.into());
    }
    if let Some(model) = terminal.model {
        metadata.insert("executionModel".into(), model);
    }
    if let Some(plan) = plan {
        metadata.insert("plan".into(), plan);
    }
    if no_visible && terminal.kind != "turn_cancelled" {
        metadata.insert("noVisibleReply".into(), true.into());
        if terminal.safe_error.is_none() && terminal.kind != "turn_suspended" {
            metadata.insert("safeErrorCode".into(), "no_visible_result".into());
        }
    }
    let mut message = Map::new();
    message.insert("text".into(), terminal.text.into());
    message.insert(
        "replyToMessageId".into(),
        envelope.message.id.clone().into(),
    );
    if !artifacts.is_empty() {
        message.insert("artifacts".into(), Value::Array(artifacts));
    }
    if !changed_files.is_empty() {
        message.insert("changedFiles".into(), Value::Array(changed_files));
    }
    json!({
        "actionId":action_id,"transport":target.transport,"accountId":target.account_id,
        "peer":peer(target),"message":message,"metadata":metadata,
    })
}
