//! Source queue claim -> binding -> BTCC -> outbound -> terminal claim.

use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::Arc,
};

use serde_json::json;

use super::super::restart_handoff::NativeRestartHandoff;
use super::{
    NativeIngressDelivery, NativeIngressPoll, action,
    bind::{self, Envelope},
};
use crate::{
    btcc::{Btcc, StopRequest, TurnOutcomeKind, WorkStatus},
    gateway::{ClaimedInboundEvent, NativeInboundQueue, QueuedInboundEvent},
    workspace::SessionBindingStore,
};

struct Executed {
    delivered: usize,
    eligible_turn_id: Option<String>,
}

pub(super) struct DispatchDependencies {
    pub queue: Arc<NativeInboundQueue>,
    pub btcc: Btcc,
    pub bindings: SessionBindingStore,
    pub data_root: PathBuf,
    pub default_workspace: PathBuf,
    pub delivery: Arc<dyn NativeIngressDelivery>,
    pub subsessions: Arc<crate::btcc::NativeSubsessionService>,
    pub restart_handoff: Arc<NativeRestartHandoff>,
}

pub(super) fn session_key(record: &QueuedInboundEvent) -> String {
    Envelope::from_record(record)
        .map(|envelope| {
            let base = envelope
                .routing_hints
                .as_ref()
                .and_then(|hints| hints.session_id.as_deref())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| {
                    let peer_kind = match envelope.peer.kind {
                        crate::btcc::PeerKind::Dm => "dm",
                        crate::btcc::PeerKind::Group => "group",
                        crate::btcc::PeerKind::Thread => "thread",
                        crate::btcc::PeerKind::Channel => "channel",
                    };
                    format!(
                        "{}:{}:{}:{}",
                        envelope.transport, envelope.account_id, peer_kind, envelope.peer.id
                    )
                });
            if envelope
                .control
                .as_ref()
                .and_then(|value| value.get("kind"))
                .and_then(serde_json::Value::as_str)
                == Some("cancel_turn")
            {
                let request = envelope
                    .control
                    .as_ref()
                    .and_then(|value| value.get("requestId"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("undefined");
                return format!("{base}:cancel:{request}");
            }
            base
        })
        .unwrap_or_else(|_| record.queue_id.clone())
}

pub(super) fn eligible_for_claim(
    record: &QueuedInboundEvent,
    waiting_sessions: &HashSet<String>,
    active_sessions: &HashSet<String>,
    batch_sessions: &mut HashSet<String>,
) -> bool {
    let session = session_key(record);
    let is_control = Envelope::from_record(record).is_ok_and(|envelope| envelope.control.is_some());
    if active_sessions.contains(&session)
        || (!is_control && waiting_sessions.contains(&session))
        || batch_sessions.contains(&session)
    {
        return false;
    }
    batch_sessions.insert(session)
}

pub(super) async fn one(
    item: ClaimedInboundEvent,
    deps: DispatchDependencies,
) -> NativeIngressPoll {
    let DispatchDependencies {
        queue,
        btcc,
        bindings,
        data_root,
        default_workspace,
        delivery,
        subsessions,
        restart_handoff,
    } = deps;
    let result = execute(
        &item,
        &btcc,
        &bindings,
        &data_root,
        &default_workspace,
        delivery.as_ref(),
        subsessions.as_ref(),
    )
    .await;
    match result {
        Ok(executed) => match queue.complete(
            &item,
            json!({
                "source":"gateway/btcc/btcc-inbound-dispatcher.ts","dispatchStatus":"handled",
                "handled":true,"delivered":executed.delivered,
            }),
        ) {
            Ok(true) => {
                if let Some(turn_id) = executed.eligible_turn_id
                    && let Err(error) = restart_handoff.after_final(&turn_id).await
                {
                    eprintln!("[native-restart] handoff code={error}");
                }
                NativeIngressPoll {
                    handled: 1,
                    delivered: executed.delivered,
                    ..Default::default()
                }
            }
            _ => NativeIngressPoll {
                interrupted: 1,
                ..Default::default()
            },
        },
        Err(error) => {
            // BTCC supplies a stable code here, never the provider body or prompt.
            // Keep that cause observable when the outer queue error is generic.
            if error.code == "inbound_turn_interrupted"
                && error.message.len() <= 128
                && error
                    .message
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
            {
                eprintln!("[native-btcc] interrupted code={}", error.message);
            }
            let _ = queue.park_for_process_replacement(&item, error.code);
            NativeIngressPoll {
                interrupted: 1,
                ..Default::default()
            }
        }
    }
}

async fn execute(
    item: &ClaimedInboundEvent,
    btcc: &Btcc,
    bindings: &SessionBindingStore,
    data_root: &Path,
    default_workspace: &Path,
    delivery: &dyn NativeIngressDelivery,
    subsessions: &crate::btcc::NativeSubsessionService,
) -> Result<Executed, super::NativeIngressError> {
    let envelope = Envelope::from_record(&item.record)?;
    let kind = envelope
        .control
        .as_ref()
        .and_then(|control| control.get("kind"))
        .and_then(serde_json::Value::as_str);
    let (binding, outcome) = match kind {
        None => {
            let request =
                bind::bind_and_request(&envelope, bindings, data_root, default_workspace).await?;
            let session_id = request.session_id.clone();
            let outcome = btcc.run_turn(request).await.map_err(|error| {
                super::NativeIngressError::new("inbound_turn_interrupted", error.code())
            })?;
            let binding = bindings
                .get_by_session_id(&session_id)
                .await
                .map_err(|_| {
                    super::NativeIngressError::new(
                        "session_binding_unavailable",
                        "Session binding unavailable",
                    )
                })?
                .ok_or_else(|| {
                    super::NativeIngressError::new(
                        "session_binding_missing",
                        "Session binding unavailable",
                    )
                })?;
            (binding, outcome)
        }
        Some("cancel_turn") => {
            let binding = bind::existing_control_binding(&envelope, bindings).await?;
            let turn_id = bind::routed_turn_id(&envelope);
            if envelope
                .control
                .as_ref()
                .and_then(|value| value.get("turnId"))
                .and_then(serde_json::Value::as_str)
                != Some(turn_id)
            {
                return Err(super::NativeIngressError::new(
                    "inbound_control_invalid",
                    "Cancellation identity mismatch",
                ));
            }
            let outcome = btcc
                .stop_turn(StopRequest {
                    turn_id: turn_id.into(),
                })
                .await
                .map_err(|error| {
                    super::NativeIngressError::new("inbound_turn_interrupted", error.code())
                })?;
            (binding, outcome)
        }
        Some("resume_turn") => {
            let binding = bind::existing_control_binding(&envelope, bindings).await?;
            let request = bind::control_request(&envelope, &binding)?;
            let outcome = btcc.run_turn(request).await.map_err(|error| {
                super::NativeIngressError::new("inbound_turn_interrupted", error.code())
            })?;
            (binding, outcome)
        }
        Some(_) => {
            return Err(super::NativeIngressError::new(
                "inbound_control_unsupported",
                "Unknown inbound control",
            ));
        }
    };
    let internal_subsession = matches!(
        binding.role,
        crate::workspace::SessionRole::Worker | crate::workspace::SessionRole::Steward
    );
    if internal_subsession {
        complete_subsession_child(
            subsessions,
            &binding.session_id,
            bind::routed_turn_id(&envelope),
            &outcome,
        )
        .await?;
    }
    if internal_subsession {
        return Ok(Executed {
            delivered: 0,
            eligible_turn_id: None,
        });
    }
    let actions = action::actions(item, &envelope, &binding, &outcome)?;
    let eligible = match &outcome.result {
        TurnOutcomeKind::Delivered(value) if value.runtime_failure.is_none() => {
            Some(value.turn_id.clone())
        }
        _ => None,
    };
    let mut delivered = 0;
    let mut final_delivered = false;
    for action in actions {
        let final_action = action
            .pointer("/metadata/kind")
            .and_then(serde_json::Value::as_str)
            == Some("final_result");
        if !delivery.deliver(binding.session_id.clone(), action).await? {
            return Err(super::NativeIngressError::new(
                "inbound_delivery_interrupted",
                "App result delivery unavailable",
            ));
        }
        delivered += 1;
        final_delivered |= final_action;
    }
    Ok(Executed {
        delivered,
        eligible_turn_id: final_delivered.then_some(eligible).flatten(),
    })
}

async fn complete_subsession_child(
    subsessions: &crate::btcc::NativeSubsessionService,
    session_id: &str,
    turn_id: &str,
    outcome: &crate::btcc::TurnOutcome,
) -> Result<(), super::NativeIngressError> {
    if matches!(
        outcome.result,
        TurnOutcomeKind::Cancelled { .. } | TurnOutcomeKind::AlreadyCancelled { .. }
    ) {
        return subsessions
            .complete_child(
                session_id,
                turn_id,
                "cancelled",
                "Delegated work was cancelled by its parent.".into(),
            )
            .await
            .map_err(|error| {
                super::NativeIngressError::new("subsession_result_commit_failed", error.code())
            });
    }
    let (content, work_status) = match &outcome.result {
        TurnOutcomeKind::Delivered(value) => (value.content.as_str(), value.work_status),
        TurnOutcomeKind::AlreadyDelivered(value) => (value.content.as_str(), value.work_status),
        _ => return Ok(()),
    };
    let status = match work_status {
        Some(WorkStatus::Completed) => "success",
        Some(WorkStatus::Blocked) => "blocked",
        Some(WorkStatus::Abandoned) => "failed",
        _ => {
            return Err(super::NativeIngressError::new(
                "subsession_work_incomplete",
                "Subsession Work is not terminal",
            ));
        }
    };
    subsessions
        .complete_child(session_id, turn_id, status, content.to_owned())
        .await
        .map_err(|error| {
            super::NativeIngressError::new("subsession_result_commit_failed", error.code())
        })
}

#[cfg(test)]
mod tests;
