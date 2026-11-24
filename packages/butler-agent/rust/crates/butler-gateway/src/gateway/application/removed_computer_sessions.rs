use butler_turn::conversation::{
    ConversationPartKind, ConversationRole, ConversationStatus, ConversationVisibility,
    TransferTurn,
};
use rusqlite::{Connection, params};
use serde_json::{Map, Value};

use super::{
    AppApplication, AppStorageError, app_error, projection::row_from_runtime_event,
    retention::store_progress_row,
};
use crate::gateway::GatewayApplicationError;

// Imported projections have no local source events. Distinguish them from
// snapshots produced by local retention before an imported turn was projected.
const TRANSFER_HIGH_WATER: i64 = -1;

impl AppApplication {
    pub(super) async fn project_transferred(
        &self,
        chat_id: String,
        turns: Vec<TransferTurn>,
    ) -> Result<(), GatewayApplicationError> {
        if turns.is_empty() {
            return Ok(());
        }
        self.storage
            .execute(move |db| {
                let count: usize = db
                    .query_row(
                        "SELECT COUNT(*) FROM turns t JOIN app_terminal_turn_projections p ON p.turn_id=t.id
                         WHERE t.chat_id=?1 AND p.source_event_high_water=?2",
                        params![chat_id, TRANSFER_HIGH_WATER],
                        |row| row.get(0),
                    )
                    .map_err(AppStorageError::sqlite)?;
                if count >= turns.len() {
                    return Ok(());
                }
                let tx = db.savepoint().map_err(AppStorageError::sqlite)?;
                for entry in turns {
                    let turn = &entry.turn;
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
                    project_progress(&tx, &chat_id, state, &entry)?;
                    for message in entry.messages {
                        let (role, status, public_id) = match message.role {
                            ConversationRole::User => ("user", "sent", &entry.outcome.request_message_id),
                            ConversationRole::Assistant => ("assistant", "delivered", &entry.outcome.public_assistant_message_id),
                            _ => continue,
                        };
                        // Canonical admission marks prompt-visible messages as Model. The
                        // outcome identifies which of them are the public conversation.
                        if message.visibility != ConversationVisibility::User
                            && !(message.visibility == ConversationVisibility::Model
                                && public_id.as_ref() == Some(&message.id))
                        {
                            continue;
                        }
                        let text = message.parts.iter()
                            .filter(|part| part.kind == ConversationPartKind::Text)
                            .filter_map(|part| part.content_json["text"].as_str())
                            .collect::<Vec<_>>()
                            .join("\n");
                        tx.execute(
                            "INSERT OR IGNORE INTO messages(id,chat_id,turn_id,role,text,status,created_at,updated_at) \
                             VALUES(?1,?2,?3,?4,?5,?6,?7,?7)",
                            params![message.id, chat_id, turn.id, role, text, status, message.created_at],
                        ).map_err(AppStorageError::sqlite)?;
                    }
                }
                tx.commit().map_err(AppStorageError::sqlite)
            })
            .await
            .map_err(app_error)
    }
}

fn project_progress(
    db: &Connection,
    chat_id: &str,
    state: &str,
    entry: &TransferTurn,
) -> Result<(), AppStorageError> {
    let turn = &entry.turn;
    let inserted = db.execute(
        "INSERT INTO app_terminal_turn_projections(
            turn_id,chat_id,terminal_state,progress_rows_json,source_event_high_water,compacted_at)
         VALUES(?1,?2,?3,'[]',?4,datetime('now'))
         ON CONFLICT(turn_id) DO UPDATE SET source_event_high_water=excluded.source_event_high_water
         WHERE app_terminal_turn_projections.source_event_high_water<>excluded.source_event_high_water",
        params![turn.id, chat_id, state, TRANSFER_HIGH_WATER],
    ).map_err(AppStorageError::sqlite)?;
    if inserted == 0 {
        return Ok(());
    }
    let mut sequence = 0;
    for message in &entry.messages {
        for part in &message.parts {
            let kind = match part.kind {
                ConversationPartKind::ToolCall => "tool.started",
                ConversationPartKind::ToolResult => match part.content_json["status"].as_str() {
                    Some("cancelled") => "tool.cancelled",
                    Some("failed") => "tool.failed",
                    _ if part.status == Some(ConversationStatus::Failed)
                        || part.content_json["ok"].as_bool() == Some(false) =>
                    {
                        "tool.failed"
                    }
                    _ => "tool.completed",
                },
                _ => continue,
            };
            let Some(call_id) = part
                .parent_tool_call_id
                .as_ref()
                .or(part.tool_call_id.as_ref())
            else {
                continue;
            };
            let mut payload = Map::from_iter([
                ("toolCallId".into(), call_id.clone().into()),
                ("bridgePhase".into(), "btcc_operation".into()),
                ("semanticBlockId".into(), format!("tool-{call_id}").into()),
            ]);
            for (source, target) in [
                ("safeToolName", "toolName"),
                ("safeLabel", "safeLabel"),
                ("safeInputLabel", "inputLabel"),
                ("workBlockId", "workBlockId"),
                ("workBlockLabel", "workBlockLabel"),
            ] {
                if let Some(value) = part.content_json.get(source) {
                    payload.insert(target.into(), value.clone());
                }
            }
            sequence += 1;
            let id = format!("{}:tool:{sequence}", turn.id);
            if let Some(row) =
                row_from_runtime_event(kind, &payload, &id, &message.created_at, Some(sequence))
            {
                // Negative keys preserve canonical part order and leave local event IDs free.
                store_progress_row(
                    db,
                    &turn.id,
                    i64::MIN + sequence.cast_signed(),
                    &Value::Object(row),
                )?;
            }
        }
    }
    Ok(())
}
