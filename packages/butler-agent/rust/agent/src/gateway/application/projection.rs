//! Owned transcript-to-App projection lifecycle.

mod byte_window;
mod checkpoint;
mod final_candidate;
mod final_result;
mod final_turn_events;
mod non_final;
mod owner;
mod staging;
mod terminal_records;
mod transcript_file;
mod turn_event_sequence;

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
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
pub(super) use owner::ProjectionOwner;
pub(super) use transcript_file::sync_chat_once;

#[derive(Clone)]
pub(super) struct ProjectionContext {
    storage: AppStorage,
    dependencies: std::sync::Arc<AppApplicationDependencies>,
    subscribers: EventSubscribers,
    butler_data: PathBuf,
    queue_wake: super::queue_dispatcher::QueueWake,
    retention_wake: super::retention::RetentionWake,
}
impl ProjectionContext {
    pub(super) fn new(
        storage: AppStorage,
        dependencies: std::sync::Arc<AppApplicationDependencies>,
        subscribers: EventSubscribers,
        butler_data: PathBuf,
        queue_wake: super::queue_dispatcher::QueueWake,
        retention_wake: super::retention::RetentionWake,
    ) -> Self {
        Self {
            storage,
            dependencies,
            subscribers,
            butler_data,
            queue_wake,
            retention_wake,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TranscriptEvent {
    pub event_id: String,
    pub session_id: String,
    pub kind: String,
    pub timestamp: String,
    pub payload: Map<String, Value>,
    #[serde(default)]
    pub transport: Option<String>,
    #[serde(default)]
    pub metadata: Option<Map<String, Value>>,
}

async fn project_event(
    context: &ProjectionContext,
    chat_id: &str,
    event: TranscriptEvent,
    checkpoint: Checkpoint,
) -> Result<bool, GatewayApplicationError> {
    if event.transport.as_deref() != Some("app") {
        return save_checkpoint(context, checkpoint).await.map(|()| true);
    }
    if event.kind == "outbound" {
        let Some(action) = event
            .payload
            .get("actionId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
        else {
            return save_checkpoint(context, checkpoint).await.map(|()| true);
        };
        let claim = staging::claim_id_from_event(&event);
        let chat = chat_id.to_owned();
        let now = context.dependencies.identity_clock.now_iso();
        context
            .storage
            .execute(move |db| {
                let tx = db
                    .transaction()
                    .map_err(super::storage::AppStorageError::sqlite)?;
                if !staging::projected(&tx, &action)? {
                    staging::stage(&tx, &action, &chat, &event, claim.as_deref(), &now)?;
                }
                checkpoint::save(&tx, &checkpoint, &now)?;
                tx.commit().map_err(super::storage::AppStorageError::sqlite)
            })
            .await
            .map_err(app_error)?;
        return Ok(true);
    }
    if event.kind != "delivery" {
        return save_checkpoint(context, checkpoint).await.map(|()| true);
    }
    let Some(action) = event
        .payload
        .get("actionId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
    else {
        return save_checkpoint(context, checkpoint).await.map(|()| true);
    };
    let stored = context
        .storage
        .execute({
            let action = action.clone();
            move |db| staging::load_awaiting(db, &action)
        })
        .await
        .map_err(app_error)?;
    let Some((stored_chat, outbound)) = stored else {
        return save_checkpoint(context, checkpoint).await.map(|()| true);
    };
    let work_outcome = projected_work_outcome(&stored_chat, &outbound);
    if event.payload.get("ok") != Some(&Value::Bool(true)) {
        let now = context.dependencies.identity_clock.now_iso();
        return context
            .storage
            .execute(move |db| {
                let tx = db
                    .transaction()
                    .map_err(super::storage::AppStorageError::sqlite)?;
                staging::delete(&tx, &action)?;
                checkpoint::save(&tx, &checkpoint, &now)?;
                tx.commit().map_err(super::storage::AppStorageError::sqlite)
            })
            .await
            .map_err(app_error)
            .map(|()| true);
    }
    let non_final_event = outbound.clone();
    let non_final_action = action.clone();
    let non_final_chat = stored_chat.clone();
    let non_final_checkpoint = checkpoint.clone();
    let non_final_now = context.dependencies.identity_clock.now_iso();
    let non_final_ids = non_final::ProjectionIds {
        event_id: format!(
            "turn-event-{}",
            context.dependencies.identity_clock.new_uuid()
        ),
        message_id: format!("message-{}", context.dependencies.identity_clock.new_uuid()),
    };
    let materialization_data = context.butler_data.clone();
    let materialization_chat = stored_chat.clone();
    let materialization_event = outbound.clone();
    let worker_materialization = context
        .storage
        .execute(move |db| {
            final_candidate::worker_materialization(
                db,
                &materialization_data,
                &materialization_chat,
                &materialization_event,
            )
        })
        .await
        .map_err(app_error)?;
    let worker_files = match worker_materialization {
        Some(request) => {
            context
                .dependencies
                .artifact_materializer
                .materialize(request)
                .await?
        }
        None => Vec::new(),
    };
    let non_final_subscribers = context.subscribers.clone();
    let outcome = context
        .storage
        .execute(move |db| {
            non_final::apply(
                db,
                non_final::ApplyInput {
                    chat_id: &non_final_chat,
                    action_id: &non_final_action,
                    outbound: &non_final_event,
                    cursor: &non_final_checkpoint,
                    now: &non_final_now,
                    subscribers: &non_final_subscribers,
                    ids: non_final_ids,
                    worker_files,
                },
            )
        })
        .await
        .map_err(app_error)?;
    if outcome.handled {
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
            context.retention_wake.turn(turn).await?;
        }
        return Ok(true);
    }
    let terminal_root = context.butler_data.clone();
    let terminal_event = outbound.clone();
    let disposition = tokio::task::spawn_blocking(move || {
        terminal_records::disposition(&terminal_root, &terminal_event)
    })
    .await
    .map_err(|_| GatewayApplicationError::Internal)?;
    match disposition {
        terminal_records::Disposition::Accept => {}
        terminal_records::Disposition::Defer => {
            let now = context.dependencies.identity_clock.now_iso();
            return context
                .storage
                .execute(move |db| {
                    let tx = db
                        .transaction()
                        .map_err(super::storage::AppStorageError::sqlite)?;
                    staging::defer(&tx, &action, &now)?;
                    checkpoint::save(&tx, &checkpoint, &now)?;
                    tx.commit().map_err(super::storage::AppStorageError::sqlite)
                })
                .await
                .map_err(app_error)
                .map(|()| true);
        }
        terminal_records::Disposition::Reject => {
            let now = context.dependencies.identity_clock.now_iso();
            return context
                .storage
                .execute(move |db| {
                    let tx = db
                        .transaction()
                        .map_err(super::storage::AppStorageError::sqlite)?;
                    staging::delete(&tx, &action)?;
                    staging::mark(&tx, &action, &outbound.event_id, &stored_chat, &now)?;
                    checkpoint::save(&tx, &checkpoint, &now)?;
                    tx.commit().map_err(super::storage::AppStorageError::sqlite)
                })
                .await
                .map_err(app_error)
                .map(|()| true);
        }
    }
    project_final(context, stored_chat, outbound, Some(checkpoint)).await
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
    .map_err(|_| GatewayApplicationError::Internal)?;
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
                            .transaction()
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
    let continuation = if candidate.activates_plan {
        let plan = candidate.plan.as_ref().expect("validated active plan");
        let source_client_id = format!("client-plan-activated-{}", candidate.turn_id);
        let client_message_id = super::admission_identity::stable_client_id(
            Some(&Value::String(source_client_id)),
            &*context.dependencies.identity_clock,
        )?;
        Some(super::settings::PlanContinuation {
            queued_id: format!("queued-{}", context.dependencies.identity_clock.new_uuid()),
            client_message_id,
            chat_id: candidate.chat_id.clone(),
            plan_id: plan["id"].as_str().expect("validated plan id").to_owned(),
            plan_title: plan["title"]
                .as_str()
                .expect("validated plan title")
                .to_owned(),
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
                candidate,
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
        context.retention_wake.turn(settled_turn).await?;
        context.queue_wake.chat(settled_chat).await?;
    }
    Ok(projected)
}

fn projected_work_outcome(
    chat_id: &str,
    event: &TranscriptEvent,
) -> Option<AppWorkStreamTurnOutcome> {
    let metadata = event.payload.get("metadata")?.as_object()?;
    let kind = metadata.get("kind")?.as_str()?;
    let (outcome, status_note) = match kind {
        "turn_failed" => ("failed", "Reconciled after failed turn replay."),
        "turn_cancelled" => ("cancelled", "Reconciled after cancelled turn replay."),
        _ => return None,
    };
    Some(AppWorkStreamTurnOutcome {
        session_id: super::app_session_hint(chat_id),
        turn_id: metadata.get("turnId")?.as_str()?.to_owned(),
        outcome: outcome.into(),
        status_note: status_note.into(),
    })
}

pub(super) async fn sync_deferred_once(
    context: &ProjectionContext,
) -> Result<bool, GatewayApplicationError> {
    let mut after = String::new();
    while sync_deferred_step(context, &mut after).await? {}
    Ok(false)
}

pub(super) async fn sync_deferred_step(
    context: &ProjectionContext,
    after: &mut String,
) -> Result<bool, GatewayApplicationError> {
    let cursor = after.clone();
    let row = context
        .storage
        .execute(move |db| staging::deferred_batch(db, &cursor, 1))
        .await
        .map_err(app_error)?
        .into_iter()
        .next();
    let Some((action, chat, event)) = row else {
        return Ok(false);
    };
    *after = action.clone();
    let root = context.butler_data.clone();
    let check = event.clone();
    let disposition =
        tokio::task::spawn_blocking(move || terminal_records::disposition(&root, &check))
            .await
            .map_err(|_| GatewayApplicationError::Internal)?;
    match disposition {
        terminal_records::Disposition::Defer => {}
        terminal_records::Disposition::Accept => {
            let _ = project_final(context, chat, event, None).await?;
        }
        terminal_records::Disposition::Reject => {
            let now = context.dependencies.identity_clock.now_iso();
            context
                .storage
                .execute(move |db| {
                    let tx = db
                        .transaction()
                        .map_err(super::storage::AppStorageError::sqlite)?;
                    staging::delete(&tx, &action)?;
                    staging::mark(&tx, &action, &event.event_id, &chat, &now)?;
                    tx.commit().map_err(super::storage::AppStorageError::sqlite)
                })
                .await
                .map_err(app_error)?;
        }
    }
    Ok(true)
}

async fn save_checkpoint(
    context: &ProjectionContext,
    value: Checkpoint,
) -> Result<(), GatewayApplicationError> {
    let now = context.dependencies.identity_clock.now_iso();
    context
        .storage
        .execute(move |db| checkpoint::save(db, &value, &now))
        .await
        .map_err(app_error)
}
