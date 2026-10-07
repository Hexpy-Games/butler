//! Durable execution identity, independent of the permanent sidebar channel.
use crate::gateway::application::{AppApplication, AppStorageError, app_error};
use crate::gateway::{GatewayApplicationError, app_session_hint};
use rusqlite::{Connection, OptionalExtension};

pub(in crate::gateway::application) fn runtime_hint(
    db: &Connection,
    chat: &str,
) -> Result<String, AppStorageError> {
    let hint: Option<String> = db
        .query_row(
            "SELECT runtime_session_hint FROM chats WHERE id=?1",
            [chat],
            |row| row.get(0),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?
        .flatten();
    Ok(hint.unwrap_or_else(|| app_session_hint(chat)))
}
impl AppApplication {
    pub(crate) async fn runtime_hint(&self, chat: &str) -> Result<String, GatewayApplicationError> {
        let chat = chat.to_owned();
        self.storage
            .read(move |db| runtime_hint(db, &chat))
            .await
            .map_err(app_error)
    }
}
