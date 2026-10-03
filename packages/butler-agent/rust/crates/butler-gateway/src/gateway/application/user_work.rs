//! Shutdown decisions read live user work, never failed queue history or jobs.
use serde_json::{Value, json};

use super::{AppApplication, app_error, storage::AppStorageError};
use crate::gateway::GatewayApplicationError;

impl AppApplication {
    pub(crate) async fn read_user_work(&self) -> Result<Value, GatewayApplicationError> {
        let (turns, queued) = self.storage.execute(counts).await.map_err(app_error)?;
        // Display activity can retain old waiting cards after a child completed.
        // Execution authority, not that display history, decides shutdown safety.
        let delegated = self.dependencies.subsessions.user_work_present().await?;
        let active = turns > 0 || queued > 0 || delegated;
        Ok(json!({
            "classification": if active { "active_work_detected" } else { "no_active_work" },
            "active_turn_count": turns, "queued_message_count": queued,
            "delegated_work_present": delegated, "raw_text_included": false,
        }))
    }
}

fn counts(db: &mut rusqlite::Connection) -> Result<(u64, u64), AppStorageError> {
    // Both predicates use existing state indexes and run on the SQLite lane.
    // Includes project chats, executing schedules and suspended approvals.
    // Terminal runtime_fault and failed/retryable history are deliberately absent.
    db.query_row(
        "SELECT \
         (SELECT COUNT(*) FROM turns WHERE state IN \
          ('queued','accepted','thinking','streaming','waiting_for_form',\
           'waiting_for_tool','cancelling','retrying')), \
         (SELECT COUNT(*) FROM session_queued_messages \
          WHERE state IN ('queued','dispatching') \
          AND (state='queued' OR turn_id IS NULL))",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .map_err(AppStorageError::sqlite)
}
