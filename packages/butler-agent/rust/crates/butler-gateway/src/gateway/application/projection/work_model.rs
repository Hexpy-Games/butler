//! Change-driven projection of the canonical BTCC outbox; no idle queries.
use super::ProjectionContext;
use crate::gateway::GatewayApplicationError;
use crate::gateway::application::{app_error, events};
use rusqlite::OptionalExtension;
use serde_json::json;

pub(super) async fn drain(context: &ProjectionContext) -> Result<(), GatewayApplicationError> {
    let after = context.storage.execute(|db| {
        db.execute_batch("CREATE TABLE IF NOT EXISTS work_model_projection_cursor(singleton INTEGER PRIMARY KEY CHECK(singleton=1),seq INTEGER NOT NULL)")
            .map_err(super::super::storage::AppStorageError::sqlite)?;
        db.query_row("SELECT seq FROM work_model_projection_cursor WHERE singleton=1", [], |r| r.get::<_,u64>(0))
            .optional().map(Option::unwrap_or_default).map_err(super::super::storage::AppStorageError::sqlite)
    }).await.map_err(app_error)?;
    let mut after = after;
    loop {
        let page = context
            .dependencies
            .session_work_progress
            .work_model(String::new(), "outbox".into(), json!({"after":after}))
            .await?;
        let Some(events) = page.as_array() else {
            return Err(GatewayApplicationError::internal());
        };
        if events.is_empty() {
            return Ok(());
        }
        let subscribers = context.subscribers.clone();
        let events = events.clone();
        after = context.storage.execute(move |db| {
            let tx = db.transaction().map_err(super::super::storage::AppStorageError::sqlite)?;
            let mut latest = after;
            for event in events {
                let seq = event["event_seq"].as_u64().unwrap_or_default();
                if seq <= latest { continue; }
                let kind = event["kind"].as_str().unwrap_or("work_model.changed");
                if let Some(payload) = event.as_object() {
                    events::append(&tx, &subscribers, kind, None, payload.clone(), &chrono::Utc::now().to_rfc3339())?;
                }
                latest = seq;
            }
            tx.execute("INSERT INTO work_model_projection_cursor VALUES(1,?1) ON CONFLICT(singleton) DO UPDATE SET seq=excluded.seq", [latest])
                .map_err(super::super::storage::AppStorageError::sqlite)?;
            tx.commit().map_err(super::super::storage::AppStorageError::sqlite)?;
            Ok(latest)
        }).await.map_err(app_error)?;
    }
}
