//! A session response's App rows share one WAL snapshot and one pool lease.
use super::super::{
    AppApplication, AppSessionSummary, AppSessionViewPage, GatewayApplicationError, app_error,
    automations, context_details, events, progress_view, read_model, sessions,
    storage::{AppStorageCode, AppStorageError},
};
use crate::gateway::{SessionArtifactSummary, TurnProgressSnapshotView, TurnRecord};
use serde_json::Value;

pub(super) struct Snapshot {
    pub session: AppSessionSummary,
    pub message_page: read_model::SessionMessagePage,
    pub latest_with_progress: Option<(TurnRecord, TurnProgressSnapshotView)>,
    pub artifacts: Vec<SessionArtifactSummary>,
    pub context_records: context_details::records::Records,
    pub event_cursor: u64,
    pub automation_targets: Value,
}

pub(super) async fn read(
    app: &AppApplication,
    id: String,
    page: AppSessionViewPage,
) -> Result<Snapshot, GatewayApplicationError> {
    let facts = app.dependencies.settings_facts.snapshot()?;
    let subscribers = app.subscribers.clone();
    let now = app.dependencies.identity_clock.now_iso();
    app.storage
        .read(move |db| {
            let session = sessions::read::session(db, &id)?;
            let message_page = read_model::list_message_page(
                db,
                &id,
                page.after_cursor,
                page.before_cursor,
                page.limit,
            )?;
            let latest_with_progress = read_model::latest_turn(db, &id)?
                .map(|turn| {
                    let progress = match message_page
                        .view
                        .turn_progress
                        .as_ref()
                        .and_then(|progress| progress.get(&turn.id))
                        .cloned()
                    {
                        Some(progress) => Some(progress),
                        None => progress_view::read(db, &turn.id)?,
                    }
                    .ok_or_else(|| {
                        AppStorageError::new(
                            AppStorageCode::AppProjectionMissing,
                            "Turn progress is unavailable.",
                        )
                    })?;
                    Ok::<_, AppStorageError>((turn, progress))
                })
                .transpose()?;
            let artifacts = read_model::list_artifacts(db, &id)?;
            let messages = context_messages(db, &id, &page, &message_page)?;
            let context_records = context_details::records::read_metadata(
                db,
                &id,
                &facts,
                &subscribers,
                &now,
                context_details::records::ViewFacts {
                    messages,
                    latest_turn: latest_with_progress.as_ref().map(|(turn, _)| turn.clone()),
                    artifacts: artifacts.clone(),
                },
            )?;
            let event_cursor = events::latest(db)?;
            let automation_targets = automations::read_targets(db, &id)?;
            Ok(Snapshot {
                session,
                message_page,
                latest_with_progress,
                artifacts,
                context_records,
                event_cursor,
                automation_targets,
            })
        })
        .await
        .map_err(app_error)
}

// Reuse only a window that contains the exact latest context messages. Older
// cursors and small incomplete pages still query that window in this snapshot.
fn context_messages(
    db: &rusqlite::Connection,
    id: &str,
    page: &AppSessionViewPage,
    messages: &read_model::SessionMessagePage,
) -> Result<Vec<crate::gateway::MessageRecord>, AppStorageError> {
    if page.after_cursor.is_none()
        && page.before_cursor.is_none()
        && (page.limit >= 16 || !messages.has_more)
    {
        let messages = &messages.view.messages;
        Ok(messages[messages.len().saturating_sub(16)..].to_vec())
    } else {
        Ok(read_model::list_message_page(db, id, None, None, 16)?
            .view
            .messages)
    }
}
