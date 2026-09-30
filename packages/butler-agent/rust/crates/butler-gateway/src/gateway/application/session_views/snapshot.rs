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
                    let progress = progress_view::read(db, &turn.id)?.ok_or_else(|| {
                        AppStorageError::new(
                            AppStorageCode::AppProjectionMissing,
                            "Turn progress is unavailable.",
                        )
                    })?;
                    Ok::<_, AppStorageError>((turn, progress))
                })
                .transpose()?;
            let artifacts = read_model::list_artifacts(db, &id)?;
            let context_records =
                context_details::records::read(db, &id, &facts, &subscribers, &now)?;
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
