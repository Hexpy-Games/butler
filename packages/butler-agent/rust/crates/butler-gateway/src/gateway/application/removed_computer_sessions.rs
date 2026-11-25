use butler_turn::conversation::TransferToolStep;
use rusqlite::{Connection, params};
use serde_json::json;

use super::{
    AppApplication, AppStorageError, app_error,
    events::EventSubscribers,
    projection::{ProgressAppend, append_progress, row_from_runtime_event},
    service,
};
use crate::gateway::GatewayApplicationError;

pub struct RemovedComputerTurn {
    pub id: String,
    pub status: String,
    pub started_at: String,
    pub completed_at: Option<String>,
    pub messages: Vec<RemovedComputerMessage>,
    pub tools: Vec<TransferToolStep>,
}

pub struct RemovedComputerMessage {
    pub id: String,
    pub role: String,
    pub text: String,
    pub created_at: String,
}

impl AppApplication {
    pub(super) async fn project_transferred(
        &self,
        chat_id: String,
        turns: Vec<RemovedComputerTurn>,
    ) -> Result<(), GatewayApplicationError> {
        if turns.is_empty() {
            return Ok(());
        }
        let subscribers = self.subscribers.clone();
        self.storage
            .execute(move |db| {
                let count: usize = db
                    .query_row("SELECT COUNT(*) FROM turns WHERE chat_id=?1", [&chat_id], |row| row.get(0))
                    .map_err(AppStorageError::sqlite)?;
                if count >= turns.len() {
                    return Ok(());
                }
                let tx = db.savepoint().map_err(AppStorageError::sqlite)?;
                for turn in turns {
                    let (state, label) = match turn.status.as_str() {
                        "complete" => ("delivered", "Delivered"),
                        "aborted" => ("cancelled", "Cancelled"),
                        "failed" => ("failed", "Failed"),
                        _ => continue,
                    };
                    tx.execute(
                        "INSERT OR IGNORE INTO turns(id,chat_id,state,safe_status_label,retryable,cancellable,attempt,created_at,updated_at) \
                         VALUES(?1,?2,?3,?4,0,0,1,?5,?6)",
                        params![turn.id, chat_id, state, label, turn.started_at, turn.completed_at.as_ref().unwrap_or(&turn.started_at)],
                    ).map_err(AppStorageError::sqlite)?;
                    for message in turn.messages {
                        let status = match message.role.as_str() {
                            "user" => "sent",
                            "assistant" => "delivered",
                            _ => continue,
                        };
                        tx.execute(
                            "INSERT OR IGNORE INTO messages(id,chat_id,turn_id,role,text,status,created_at,updated_at) \
                             VALUES(?1,?2,?3,?4,?5,?6,?7,?7)",
                            params![message.id, chat_id, turn.id, message.role, message.text, status, message.created_at],
                        ).map_err(AppStorageError::sqlite)?;
                    }
                    for step in &turn.tools {
                        append_tool_step(&tx, &subscribers, &chat_id, &turn.id, step)?;
                    }
                }
                tx.commit().map_err(AppStorageError::sqlite)
            })
            .await
            .map_err(app_error)
    }
}

fn append_tool_step(
    db: &Connection,
    subscribers: &EventSubscribers,
    chat: &str,
    turn: &str,
    step: &TransferToolStep,
) -> Result<(), AppStorageError> {
    let kind = match step.status.as_deref() {
        Some("completed") => "tool.completed",
        Some("failed") => "tool.failed",
        Some("cancelled") => "tool.cancelled",
        _ => "tool.started",
    };
    let call = &step.tool_call_id;
    let now = step.started_at.as_str();
    let payload = service::map(&json!({
        "toolName": step.safe_tool_name,
        "safeLabel": step.safe_label,
        "inputLabel": step.safe_input_label,
        "toolCallId": call,
        "activityKind": "used_tool",
        "bridgePhase": "btcc_operation",
        "semanticBlockId": format!("tool-{call}"),
    }))?;
    if let Some(row) = row_from_runtime_event(
        kind,
        &payload,
        &format!("{turn}:tool:{call}"),
        now,
        Some(step.ord.into()),
    ) {
        append_progress(&ProgressAppend {
            db,
            subscribers,
            chat,
            turn,
            row,
            event_type: "agent.turn_event.progress",
            source_event: None,
            now,
        })?;
    }
    Ok(())
}
