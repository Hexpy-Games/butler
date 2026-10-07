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

/// Prefer explicit runtime ownership; legacy ids only belong to unrotated chats.
pub(in crate::gateway::application) fn resolve_owner(
    db: &Connection,
    owner: &str,
) -> Result<Option<String>, AppStorageError> {
    let explicit = db
        .query_row(
            "SELECT id FROM chats WHERE runtime_session_hint=?1",
            [owner],
            |row| row.get(0),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?;
    if explicit.is_some() {
        return Ok(explicit);
    }
    let derived = owner.strip_prefix("butler/app-").unwrap_or(owner);
    db.query_row(
        "SELECT id FROM chats WHERE id=?1 AND runtime_session_hint IS NULL",
        [derived],
        |row| row.get(0),
    )
    .optional()
    .map_err(AppStorageError::sqlite)
}
impl AppApplication {
    pub(crate) async fn owner_chat(
        &self,
        owner: String,
    ) -> Result<String, GatewayApplicationError> {
        self.storage
            .read(move |db| {
                resolve_owner(db, &owner).map(|chat| {
                    chat.unwrap_or_else(|| {
                        owner
                            .strip_prefix("butler/app-")
                            .unwrap_or(&owner)
                            .to_owned()
                    })
                })
            })
            .await
            .map_err(app_error)
    }
}
