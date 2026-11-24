use rusqlite::params;

use super::{AppApplication, AppStorageError, app_error};
use crate::gateway::GatewayApplicationError;

pub struct RemovedComputerTurn {
    pub id: String,
    pub status: String,
    pub started_at: String,
    pub completed_at: Option<String>,
    pub messages: Vec<RemovedComputerMessage>,
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
                }
                tx.commit().map_err(AppStorageError::sqlite)
            })
            .await
            .map_err(app_error)
    }
}
