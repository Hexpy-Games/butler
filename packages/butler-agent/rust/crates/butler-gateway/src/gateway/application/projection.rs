//! Owned transcript-to-App projection lifecycle.

mod byte_window;
mod stream_window;
pub(super) use stream_window::TranscriptEvent;
use stream_window::projected_work_outcome;
mod checkpoint;
mod coalescing;
mod deferred;
mod delivery;
mod final_candidate;
mod final_result;
mod final_turn_events;
mod non_final;
pub(in crate::gateway::application) use non_final::row_from_runtime_event;
mod observers;
mod owner;
mod staging;
mod terminal_records;
mod transcript_file;
mod turn_event_sequence;

#[cfg(test)]
pub(in crate::gateway::application) use final_turn_events::HAS_KIND_SQL;

use std::path::PathBuf;

use serde_json::{Map, Value};

pub(in crate::gateway::application) fn normalize_committed_turn_event(
    kind: &str,
    visibility: &str,
    payload: Option<&Map<String, Value>>,
) -> Result<Map<String, Value>, super::storage::AppStorageError> {
    non_final::normalize_committed_turn_event(kind, visibility, payload)
}

use super::{
    AppApplicationDependencies, AppStorage, AppWorkStreamTurnOutcome, EventSubscribers,
    GatewayApplicationError, app_error,
};
use checkpoint::Checkpoint;
use deferred::{sync_deferred_once, sync_deferred_step};
pub(super) use owner::ProjectionOwner;
pub(super) use transcript_file::sync_chat_once;

#[derive(Clone)]
pub(super) struct ProjectionContext {
    storage: AppStorage,
    streaming: std::sync::Arc<coalescing::Buffer>,
    dependencies: std::sync::Arc<AppApplicationDependencies>,
    subscribers: EventSubscribers,
    butler_data: PathBuf,
    queue_wake: super::queue_dispatcher::QueueWake,
    retention_wake: super::retention::RetentionWake,
    automation_wake: std::sync::Arc<tokio::sync::Notify>,
    automation_queued: std::sync::Arc<std::sync::atomic::AtomicBool>,
}
impl ProjectionContext {
    fn wake_queued_automations(&self) {
        if self
            .automation_queued
            .load(std::sync::atomic::Ordering::Acquire)
        {
            self.automation_wake.notify_one();
        }
    }

    async fn finish_terminal_turn(&self, turn: String) -> Result<(), GatewayApplicationError> {
        self.retention_wake.turn(turn).await?;
        self.wake_queued_automations();
        Ok(())
    }

    pub(super) fn new(
        storage: AppStorage,
        dependencies: std::sync::Arc<AppApplicationDependencies>,
        subscribers: EventSubscribers,
        butler_data: PathBuf,
        queue_wake: super::queue_dispatcher::QueueWake,
        retention_wake: super::retention::RetentionWake,
        automation_signals: (
            std::sync::Arc<tokio::sync::Notify>,
            std::sync::Arc<std::sync::atomic::AtomicBool>,
        ),
    ) -> Self {
        Self {
            streaming: std::sync::Arc::default(),
            storage,
            dependencies,
            subscribers,
            butler_data,
            queue_wake,
            retention_wake,
            automation_wake: automation_signals.0,
            automation_queued: automation_signals.1,
        }
    }
}

async fn project_event(
    context: &ProjectionContext,
    chat: &str,
    event: TranscriptEvent,
    cursor: Checkpoint,
) -> Result<bool, GatewayApplicationError> {
    if context
        .streaming
        .handle(context, chat, &event, &cursor)
        .await?
    {
        return Ok(true);
    }
    context.streaming.flush(context, chat).await?;
    project_boundary(context, chat, event, cursor).await
}

async fn project_boundary(
    context: &ProjectionContext,
    chat_id: &str,
    event: TranscriptEvent,
    checkpoint: Checkpoint,
) -> Result<bool, GatewayApplicationError> {
    let context = context.clone();
    if event.transport.as_deref() != Some("app") {
        return save_checkpoint(&context, checkpoint).await.map(|()| true);
    }
    let Some(action) = delivery::action_id(&event) else {
        return save_checkpoint(&context, checkpoint).await.map(|()| true);
    };
    if event.kind == "outbound" {
        return delivery::stage_event(&context, chat_id, event, action, checkpoint).await;
    }
    if event.kind != "delivery" {
        return save_checkpoint(&context, checkpoint).await.map(|()| true);
    }
    let lookup = action.clone();
    let stored = context
        .storage
        .inspect(move |db| staging::load_awaiting(db, &lookup))
        .await
        .map_err(app_error)?;
    let Some((stored_chat, outbound)) = stored else {
        return save_checkpoint(&context, checkpoint).await.map(|()| true);
    };
    let context = context.clone();
    if event.payload.get("ok") != Some(&Value::Bool(true)) {
        return delivery::discard(&context, action, checkpoint).await;
    }
    let work_outcome = projected_work_outcome(&stored_chat, &outbound);
    let outcome = delivery::non_final(
        &context,
        stored_chat.clone(),
        outbound.clone(),
        action.clone(),
        checkpoint.clone(),
    )
    .await?;
    if !outcome.handled {
        return delivery::terminal(&context, stored_chat, outbound, action, checkpoint).await;
    }
    if outcome.wake_queue {
        context.queue_wake.chat(stored_chat).await?;
    }
    if let Some(turn) = outcome.terminal_turn {
        if let Some(work_outcome) = work_outcome {
            let _ = context
                .dependencies
                .work_streams
                .reconcile_turn(work_outcome)
                .await;
        }
        context.finish_terminal_turn(turn).await?;
    }
    Ok(true)
}

async fn project_final(
    context: &ProjectionContext,
    stored_chat: String,
    outbound: TranscriptEvent,
    checkpoint: Option<Checkpoint>,
) -> Result<bool, GatewayApplicationError> {
    let terminal_root = context.butler_data.clone();
    let terminal_event = outbound.clone();
    let processed_claim_verified = tokio::task::spawn_blocking(move || {
        terminal_records::verified_processed_claim(&terminal_root, &terminal_event)
    })
    .await
    .map_err(GatewayApplicationError::internal_from)?;
    let data = context.butler_data.clone();
    let candidate_event = outbound.clone();
    let candidate = context
        .storage
        .execute(move |db| {
            final_candidate::candidate(
                db,
                &data,
                &stored_chat,
                &candidate_event,
                processed_claim_verified,
            )
        })
        .await
        .map_err(app_error)?;
    let Some(candidate) = candidate else {
        let action = outbound
            .payload
            .get("actionId")
            .and_then(Value::as_str)
            .map(str::to_owned);
        return match (checkpoint, action) {
            (Some(checkpoint), Some(action)) => {
                let now = context.dependencies.identity_clock.now_iso();
                context
                    .storage
                    .execute(move |db| {
                        let tx = db
                            .savepoint()
                            .map_err(super::storage::AppStorageError::sqlite)?;
                        staging::delete(&tx, &action)?;
                        checkpoint::save(&tx, &checkpoint, &now)?;
                        tx.commit().map_err(super::storage::AppStorageError::sqlite)
                    })
                    .await
                    .map_err(app_error)
                    .map(|()| true)
            }
            (Some(checkpoint), None) => save_checkpoint(context, checkpoint).await.map(|()| true),
            (None, _) => Ok(true),
        };
    };
    let files = context
        .dependencies
        .artifact_materializer
        .materialize(candidate.materialization.clone())
        .await?;
    let active_plan = candidate.plan.as_ref().filter(|_| candidate.activates_plan);
    let continuation = if let Some(plan) = active_plan {
        // Admission validated the active plan's id and title.
        let (Some(plan_id), Some(plan_title)) = (
            plan.get("id").and_then(Value::as_str),
            plan.get("title").and_then(Value::as_str),
        ) else {
            return Err(GatewayApplicationError::internal());
        };
        let source_client_id = format!("client-plan-activated-{}", candidate.turn_id);
        let client_message_id = super::admission_identity::stable_client_id(
            Some(&Value::String(source_client_id)),
            &*context.dependencies.identity_clock,
        )?;
        Some(super::settings::PlanContinuation {
            queued_id: format!("queued-{}", context.dependencies.identity_clock.new_uuid()),
            client_message_id,
            chat_id: candidate.chat_id.clone(),
            plan_id: plan_id.to_owned(),
            plan_title: plan_title.to_owned(),
            facts: context.dependencies.settings_facts.snapshot()?,
        })
    } else {
        None
    };
    let reply_id = format!("message-{}", context.dependencies.identity_clock.new_uuid());
    let turn_event_ids = final_turn_events::FinalTurnEventIds {
        started: format!(
            "turn-event-{}",
            context.dependencies.identity_clock.new_uuid()
        ),
        completed: format!(
            "turn-event-{}",
            context.dependencies.identity_clock.new_uuid()
        ),
        turn_completed: format!(
            "turn-event-{}",
            context.dependencies.identity_clock.new_uuid()
        ),
        failed: format!(
            "turn-event-{}",
            context.dependencies.identity_clock.new_uuid()
        ),
    };
    let now = context.dependencies.identity_clock.now_iso();
    let subscribers = context.subscribers.clone();
    let settled_chat = candidate.chat_id.clone();
    let settled_turn = candidate.turn_id.clone();
    let projected = context
        .storage
        .execute(move |db| {
            final_result::apply(
                db,
                &candidate,
                final_result::FinalApply {
                    files,
                    reply_id: &reply_id,
                    now: &now,
                    subscribers: &subscribers,
                    checkpoint: checkpoint.as_ref(),
                    continuation,
                    turn_event_ids,
                },
            )
        })
        .await
        .map_err(app_error)?;
    if projected {
        let _ = context
            .dependencies
            .work_streams
            .reconcile_turn(AppWorkStreamTurnOutcome {
                session_id: super::app_session_hint(&settled_chat),
                turn_id: settled_turn.clone(),
                outcome: "completed".into(),
                status_note: "Reconciled after delivered turn replay.".into(),
            })
            .await;
        context.finish_terminal_turn(settled_turn).await?;
        context.queue_wake.chat(settled_chat).await?;
    }
    Ok(projected)
}

async fn save_checkpoint(
    context: &ProjectionContext,
    value: Checkpoint,
) -> Result<(), GatewayApplicationError> {
    if context.streaming.advance(&value) {
        return Ok(());
    }
    let now = context.dependencies.identity_clock.now_iso();
    context
        .storage
        .execute(move |db| checkpoint::save(db, &value, &now))
        .await
        .map_err(app_error)
}
