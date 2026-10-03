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
        let wake = events
            .iter()
            .filter(|e| {
                e["kind"] == "session.control_changed"
                    || (e["kind"] == "instruction.updated"
                        && e["receipt"]["status"] == "pending_safe_point")
            })
            .filter_map(|e| {
                e["session_id"]
                    .as_str()?
                    .strip_prefix("butler/app-")
                    .map(str::to_owned)
            })
            .collect::<std::collections::HashSet<_>>();
        let events = events.clone();
        after = context.storage.execute(move |db| {
            let tx = db.transaction().map_err(super::super::storage::AppStorageError::sqlite)?;
            let mut latest = after;
            for event in events {
                let seq = event["event_seq"].as_u64().unwrap_or_default();
                if seq <= latest { continue; }
                let kind = event["kind"].as_str().unwrap_or("work_model.changed");
                if event.get("receipt").is_some() { project_instruction(&tx,&event)?; }
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
        for chat in wake {
            context.queue_wake.chat(chat).await?;
        }
    }
}

fn project_instruction(
    db: &rusqlite::Connection,
    event: &serde_json::Value,
) -> Result<(), super::super::storage::AppStorageError> {
    use super::super::storage::AppStorageError;
    use rusqlite::params;
    let receipt = &event["receipt"];
    let Some(turn) = receipt["delivered_turn_id"].as_str() else {
        return Ok(());
    };
    if !matches!(receipt["status"].as_str(), Some("delivered" | "applied")) {
        return Ok(());
    }
    let Some(session) = event["session_id"]
        .as_str()
        .and_then(|s| s.strip_prefix("butler/app-"))
    else {
        return Ok(());
    };
    let key = receipt["idempotency_key"].as_str().unwrap_or_default();
    db.execute("INSERT OR IGNORE INTO messages(id,chat_id,turn_id,role,text,content_parts_json,status,created_at,updated_at,retryable) SELECT client_message_id,chat_id,?3,'user',text,content_parts_json,'sent',created_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'),0 FROM session_queued_messages WHERE chat_id=?1 AND client_message_id=?2 AND state='queued'",params![session,key,turn]).map_err(AppStorageError::sqlite)?;
    db.execute("INSERT OR IGNORE INTO message_attachments(message_id,file_id,position) SELECT q.client_message_id,COALESCE(json_extract(a.value,'$.file_id'),a.value),a.key FROM session_queued_messages q,json_each(q.attachments_json) a WHERE q.chat_id=?1 AND q.client_message_id=?2 AND q.state='queued'",params![session,key]).map_err(AppStorageError::sqlite)?;
    db.execute("UPDATE message_files SET message_id=?1 WHERE id IN (SELECT file_id FROM message_attachments WHERE message_id=?1)",[key]).map_err(AppStorageError::sqlite)?;
    db.execute("UPDATE session_queued_messages SET state='dispatched',dispatched_message_id=client_message_id,turn_id=?3,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE chat_id=?1 AND client_message_id=?2 AND state='queued'",params![session,key,turn]).map_err(AppStorageError::sqlite)?;
    Ok(())
}
