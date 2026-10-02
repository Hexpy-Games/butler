//! Source queue claim -> binding -> BTCC -> outbound -> terminal claim.

use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::Arc,
};

use serde_json::json;

use super::{
    IngressDelivery, IngressPoll, action,
    bind::{self, Envelope},
};
use crate::host::service::restart_handoff::RestartHandoff;
use butler_gateway::gateway::{ClaimedInboundEvent, InboundQueue, QueuedInboundEvent};
use butler_turn::btcc::{Btcc, StopRequest, TurnOutcomeKind, WorkStatus};
use butler_turn::workspace::SessionBindingStore;

struct Executed {
    delivered: usize,
    eligible_turn_id: Option<String>,
}

pub(super) struct DispatchDependencies {
    pub shutdown: tokio_util::sync::CancellationToken,
    pub queue: Arc<InboundQueue>,
    pub btcc: Btcc,
    pub bindings: SessionBindingStore,
    pub data_root: PathBuf,
    pub default_workspace: PathBuf,
    pub delivery: Arc<dyn IngressDelivery>,
    pub subsessions: Arc<butler_turn::btcc::SubsessionService>,
    pub restart_handoff: Arc<RestartHandoff>,
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
                        butler_turn::btcc::PeerKind::Dm => "dm",
                        butler_turn::btcc::PeerKind::Group => "group",
                        butler_turn::btcc::PeerKind::Thread => "thread",
                        butler_turn::btcc::PeerKind::Channel => "channel",
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

pub(super) async fn one(item: ClaimedInboundEvent, deps: DispatchDependencies) -> IngressPoll {
    let DispatchDependencies {
        shutdown,
        queue,
        btcc,
        bindings,
        data_root,
        default_workspace,
        delivery,
        subsessions,
        restart_handoff,
    } = deps;
    // Owner decision: a turn a crashed process was running is not resumed;
    // it runs only when its session was never bound (BTCC never started it).
    if needs_interruption_report(&item.record)
        && let Some(poll) = interrupted::settle(
            &item,
            &queue,
            &bindings,
            delivery.as_ref(),
            "crash-interrupted",
        )
        .await
    {
        return poll;
    }
    let result = execute(
        &item,
        (&btcc, &shutdown),
        &bindings,
        &data_root,
        &default_workspace,
        delivery.as_ref(),
        subsessions.as_ref(),
    )
    .await;
    match result {
        Ok(executed) => handled(&item, executed, &queue, &restart_handoff).await,
        Err(error) => {
            let subsessions = subsessions.as_ref();
            failed(
                &item,
                &error,
                &queue,
                &bindings,
                delivery.as_ref(),
                subsessions,
            )
            .await
        }
    }
}

/// Publish a truthful retryable failure after execution has unwound. BTCC's
/// flight and execution permit are released; no process replacement is needed.
async fn failed(
    item: &ClaimedInboundEvent,
    error: &super::IngressError,
    queue: &InboundQueue,
    bindings: &SessionBindingStore,
    delivery: &dyn IngressDelivery,
    subsessions: &butler_turn::btcc::SubsessionService,
) -> IngressPoll {
    // BTCC supplies a stable code here, never the provider body or prompt.
    // Keep that cause observable when the outer queue error is generic.
    if error.code == "inbound_turn_interrupted"
        && error.message.len() <= 128
        && error
            .message
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    {
        let envelope = Envelope::from_record(&item.record).ok();
        let turn_id = envelope
            .as_ref()
            .map(bind::routed_turn_id)
            .unwrap_or("unknown");
        butler_core::diagnostic!(
            "[native-btcc] interrupted turn_id={turn_id} session_id={} capability=turn_execution code={} Turn interrupted; retry is available.",
            session_key(&item.record),
            error.message
        );
    }
    let replaced = interrupted::replaced_once(&item.record);
    if let Some(code) = rejected::safe_code(error) {
        return rejected::reject(item, queue, bindings, delivery, subsessions, code).await;
    }
    if error.message == super::shutdown::INTERRUPTED
        && let Some(poll) =
            interrupted::settle(item, queue, bindings, delivery, "shutdown-interrupted").await
    {
        return poll;
    }
    if replaced
        && let Some(poll) =
            interrupted::settle(item, queue, bindings, delivery, "replacement-interrupted").await
    {
        return poll;
    }
    if replaced {
        // The turn never started, so its report is unavailable: no second replacement.
        return rejected::reject(item, queue, bindings, delivery, subsessions, error.code).await;
    }
    if let Some(poll) =
        interrupted::settle(item, queue, bindings, delivery, "runtime-interrupted").await
    {
        return poll;
    }
    rejected::reject(item, queue, bindings, delivery, subsessions, error.code).await
}

/// A BTCC error as a queue error: a rejection no replacement process can
/// change fails the item; any other error interrupts the turn.
fn turn_error(error: &butler_turn::btcc::BtccError) -> super::IngressError {
    let code = if rejected::is_rejection(error) {
        rejected::REJECTED
    } else {
        "inbound_turn_interrupted"
    };
    super::IngressError::new(code, error.code())
}

/// Settles an executed item and hands a delivered final to restart handoff.
async fn handled(
    item: &ClaimedInboundEvent,
    executed: Executed,
    queue: &InboundQueue,
    restart_handoff: &RestartHandoff,
) -> IngressPoll {
    let completed = queue
        .complete_async(
            item.clone(),
            json!({
                "source":"gateway/btcc/btcc-inbound-dispatcher.ts","dispatchStatus":"handled",
                "handled":true,"delivered":executed.delivered,
            }),
        )
        .await;
    if !matches!(completed, Ok(true)) {
        return IngressPoll {
            interrupted: 1,
            ..Default::default()
        };
    }
    if let Some(turn_id) = executed.eligible_turn_id
        && let Err(error) = restart_handoff.after_final(&turn_id).await
    {
        butler_core::diagnostic!("[native-restart] handoff code={error}");
    }
    IngressPoll {
        handled: 1,
        delivered: executed.delivered,
        ..Default::default()
    }
}

async fn execute(
    item: &ClaimedInboundEvent,
    turn: (&Btcc, &tokio_util::sync::CancellationToken),
    bindings: &SessionBindingStore,
    data_root: &Path,
    default_workspace: &Path,
    delivery: &dyn IngressDelivery,
    subsessions: &butler_turn::btcc::SubsessionService,
) -> Result<Executed, super::IngressError> {
    let (btcc, shutdown) = turn;
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
            let outcome = super::shutdown::run(btcc, request, shutdown)
                .await
                .map_err(|error| turn_error(&error))?;
            let binding = bindings
                .get_by_session_id(&session_id)
                .await
                .map_err(|source| {
                    super::IngressError::new(
                        "session_binding_unavailable",
                        "Session binding unavailable",
                    )
                    .with_source(source)
                })?
                .ok_or_else(|| {
                    super::IngressError::new(
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
                return Err(super::IngressError::new(
                    "inbound_control_invalid",
                    "Cancellation identity mismatch",
                ));
            }
            let outcome = btcc
                .stop_turn(StopRequest {
                    turn_id: turn_id.into(),
                })
                .await
                .map_err(|error| turn_error(&error))?;
            (binding, outcome)
        }
        Some("resume_turn") => {
            let binding = bind::existing_control_binding(&envelope, bindings).await?;
            let request = bind::control_request(&envelope, &binding)?;
            let outcome = super::shutdown::run(btcc, request, shutdown)
                .await
                .map_err(|error| turn_error(&error))?;
            (binding, outcome)
        }
        Some(_) => {
            return Err(super::IngressError::new(
                "inbound_control_unsupported",
                "Unknown inbound control",
            ));
        }
    };
    let internal_subsession = matches!(
        binding.role,
        butler_turn::workspace::SessionRole::Worker | butler_turn::workspace::SessionRole::Steward
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
            return Err(super::IngressError::new(
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
    subsessions: &butler_turn::btcc::SubsessionService,
    session_id: &str,
    turn_id: &str,
    outcome: &butler_turn::btcc::TurnOutcome,
) -> Result<(), super::IngressError> {
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
                super::IngressError::new("subsession_result_commit_failed", error.code())
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
            return Err(super::IngressError::new(
                "subsession_work_incomplete",
                "Subsession Work is not terminal",
            ));
        }
    };
    subsessions
        .complete_child(session_id, turn_id, status, content.to_owned())
        .await
        .map_err(|error| super::IngressError::new("subsession_result_commit_failed", error.code()))
}

mod interrupted;
mod rejected;
#[cfg(test)]
mod tests;

pub(super) fn needs_interruption_report(record: &QueuedInboundEvent) -> bool {
    interrupted::by_crash(record) || interrupted::replaced_once(record)
}

/// Startup publishes only old interrupted outcomes; it never executes queued work.
pub(super) async fn recover_interrupted(
    item: ClaimedInboundEvent,
    queue: &InboundQueue,
    bindings: &SessionBindingStore,
    delivery: &dyn IngressDelivery,
) -> Result<(), super::IngressError> {
    if interrupted::settle(&item, queue, bindings, delivery, "shutdown-interrupted")
        .await
        .is_none()
    {
        queue
            .defer_async(item, "startup_turn_not_started".into())
            .await?;
    }
    Ok(())
}
