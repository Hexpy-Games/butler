//! Admission lifecycle hooks, always outside the storage transaction.
use super::*;
use crate::gateway::MessageSendRequest;
use crate::gateway::application::storage::AppStorageCode;
use butler_core::hooks::{
    HookAttachment, HookContext, HookEnvelope, HookEvent, HookPayload, render_hook_context,
};
use rusqlite::{OptionalExtension, params};
impl AppApplication {
    pub(super) async fn session_start_hook(
        &self,
        id: String,
        source: &str,
    ) -> Result<(), GatewayApplicationError> {
        let Some(port) = &self.dependencies.hooks else {
            return Ok(());
        };
        let _ = port.reload().await;
        if !port.enabled(HookEvent::SessionStart, None) {
            return Ok(());
        }
        let payload = HookPayload {
            source: Some(source.into()),
            ..HookPayload::default()
        };
        let envelope = self
            .hook_envelope(
                &id,
                HookEvent::SessionStart,
                format!("evt_session_{id}"),
                payload,
            )
            .await?;
        let context = port
            .dispatch(envelope, self.dependencies.service_shutdown.child_token())
            .await
            .map(|dispatched| dispatched.context)
            .unwrap_or_default();
        if context.is_empty() {
            return Ok(());
        }
        self.keep_session_start_context(id, context).await
    }
    /// Waits for the session's first claimed turn, which carries it from then on.
    async fn keep_session_start_context(
        &self,
        chat: String,
        context: Vec<HookContext>,
    ) -> Result<(), GatewayApplicationError> {
        let items = stringify(&context)?;
        let now = self.dependencies.identity_clock.now_iso();
        self.storage
            .execute(move |db| {
                db.execute(
                    "INSERT INTO session_start_hook_context(chat_id,items_json,created_at) \
                     VALUES(?1,?2,?3) ON CONFLICT(chat_id) DO UPDATE SET \
                     items_json=excluded.items_json,created_at=excluded.created_at",
                    params![chat, items, now],
                )
                .map_err(AppStorageError::sqlite)?;
                Ok(())
            })
            .await
            .map_err(app_error)
    }
    /// Runs the event's handlers before admission. The result is what this
    /// message adds to its own turn's context.
    pub(super) async fn prompt_hook(
        &self,
        chat: &str,
        client: &str,
        request: &MessageSendRequest,
        inspected: &admission::Inspected,
    ) -> Result<Option<String>, GatewayApplicationError> {
        let Some(port) = &self.dependencies.hooks else {
            return Ok(None);
        };
        let _ = port.reload().await;
        if !port.enabled(HookEvent::UserPromptSubmit, None) {
            return Ok(None);
        }
        let payload = HookPayload {
            prompt: Some(
                request
                    .text
                    .as_ref()
                    .and_then(Value::as_str)
                    .unwrap_or(&inspected.prepared.text)
                    .into(),
            ),
            attachments: Some(
                inspected
                    .files
                    .iter()
                    .map(|f| HookAttachment {
                        name: f.safe_name.clone(),
                        media_type: f.mime_type.clone(),
                        bytes: f.size_bytes,
                    })
                    .collect(),
            ),
            ..HookPayload::default()
        };
        let envelope = self
            .hook_envelope(
                chat,
                HookEvent::UserPromptSubmit,
                format!("evt_prompt_{chat}_{client}"),
                payload,
            )
            .await?;
        let dispatched = port
            .dispatch(envelope, self.dependencies.service_shutdown.child_token())
            .await
            .unwrap_or_default();
        if let Some(reason) = dispatched.deny {
            return Err(public(422, "hook_blocked", &reason));
        }
        if dispatched.context.is_empty() {
            return Ok(None);
        }
        stringify(&dispatched.context).map(Some)
    }
    async fn hook_envelope(
        &self,
        chat: &str,
        event: HookEvent,
        event_id: String,
        payload: HookPayload,
    ) -> Result<HookEnvelope, GatewayApplicationError> {
        let id = chat.to_owned();
        let facts = self.dependencies.settings_facts.snapshot()?;
        let subscribers = self.subscribers.clone();
        let now = self.dependencies.identity_clock.now_iso();
        let read_now = now.clone();
        let (session, access_mode) = self
            .storage
            .execute(move |db| {
                let session = sessions::read_summary(db, &id)?;
                let settings =
                    settings::session_context_settings(db, &subscribers, &facts, &id, &read_now)?;
                Ok((session, settings.access_mode))
            })
            .await
            .map_err(app_error)?;
        let project_dir = self.project_workspace_path(session.project_id).await?;
        let cwd = project_dir.clone().unwrap_or_else(|| {
            butler_platform::user_dirs::home_dir()
                .unwrap_or_else(|| self.butler_data.clone())
                .to_string_lossy()
                .into_owned()
        });
        Ok(HookEnvelope {
            schema: "butler.hook.v1".into(),
            hook_event_name: event,
            event_id,
            occurred_at: now,
            session_id: Some(session.session_hint),
            turn_id: None,
            parent_session_id: None,
            project_dir,
            cwd,
            access_mode: Some(access_mode),
            payload,
        })
    }
}

/// The labelled text a claimed message adds to its turn. The first claim of a
/// session moves its waiting SessionStart text onto the message, so a retry of
/// that turn reads the same text and a later turn none of it.
pub(super) fn claimed_context(
    db: &mut rusqlite::Connection,
    chat: &str,
    queued_id: &str,
) -> Result<Option<String>, AppStorageError> {
    let transaction = db.savepoint().map_err(AppStorageError::sqlite)?;
    let waiting: Option<String> = transaction
        .query_row(
            "SELECT items_json FROM session_start_hook_context WHERE chat_id=?1",
            [chat],
            |row| row.get(0),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?;
    let own: Option<String> = transaction
        .query_row(
            "SELECT hook_context_json FROM session_queued_messages WHERE id=?1",
            [queued_id],
            |row| row.get(0),
        )
        .map_err(AppStorageError::sqlite)?;
    let mut items = parse_items(waiting.as_deref())?;
    items.extend(parse_items(own.as_deref())?);
    if waiting.is_some() {
        let merged = serde_json::to_string(&items).map_err(context_error)?;
        transaction
            .execute(
                "UPDATE session_queued_messages SET hook_context_json=?2 WHERE id=?1",
                params![queued_id, merged],
            )
            .map_err(AppStorageError::sqlite)?;
        transaction
            .execute(
                "DELETE FROM session_start_hook_context WHERE chat_id=?1",
                [chat],
            )
            .map_err(AppStorageError::sqlite)?;
    }
    transaction.commit().map_err(AppStorageError::sqlite)?;
    Ok(render_hook_context(&items))
}

fn parse_items(json: Option<&str>) -> Result<Vec<HookContext>, AppStorageError> {
    json.map_or_else(
        || Ok(Vec::new()),
        |json| serde_json::from_str(json).map_err(context_error),
    )
}

fn context_error(source: impl std::error::Error + Send + Sync + 'static) -> AppStorageError {
    AppStorageError::new(
        AppStorageCode::TurnRetrySnapshotMissing,
        "Hook context is unavailable.",
    )
    .with_source(source)
}
