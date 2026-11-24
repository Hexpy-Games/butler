use butler_turn::conversation::{
    ConversationPartKind, ConversationRole, ConversationVisibility, TransferTurn,
};
use rusqlite::params;

use super::{AppApplication, AppStorageError, app_error};
use crate::gateway::GatewayApplicationError;

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
                    .query_row("SELECT COUNT(*) FROM turns WHERE chat_id=?1", [&chat_id], |row| row.get(0))
                    .map_err(AppStorageError::sqlite)?;
                if count >= turns.len() {
                    return Ok(());
                }
                let tx = db.transaction().map_err(AppStorageError::sqlite)?;
                for entry in turns {
                    let turn = entry.turn;
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
                    for message in entry.messages {
                        if message.visibility != ConversationVisibility::User {
                            continue;
                        }
                        let (role, status) = match message.role {
                            ConversationRole::User => ("user", "sent"),
                            ConversationRole::Assistant => ("assistant", "delivered"),
                            _ => continue,
                        };
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
