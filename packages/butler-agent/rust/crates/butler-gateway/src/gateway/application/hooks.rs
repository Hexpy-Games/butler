//! Admission lifecycle hooks, always outside the storage transaction.
use super::*;
use crate::gateway::MessageSendRequest;
use butler_core::hooks::{HookAttachment, HookContext, HookEnvelope, HookEvent, HookPayload};
use rusqlite::params;
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
        if !context.is_empty() {
            self.keep_session_start_context(id, context).await;
        }
        Ok(())
    }
    /// Waits for the session's next admitted turn. The session may be gone by now
    /// (deleted while its hook ran); that loses the text, and nothing else.
    async fn keep_session_start_context(&self, chat: String, context: Vec<HookContext>) {
        let now = self.dependencies.identity_clock.now_iso();
        let kept = match stringify(&context) {
            Ok(items) => self
                .storage
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
                .map_err(app_error),
            Err(error) => Err(error),
        };
        if let Err(error) = kept {
            butler_core::diagnostic!("warning: SessionStart hook output not kept: {error}");
        }
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
        let mut envelope = self
            .hook_envelope(
                chat,
                HookEvent::UserPromptSubmit,
                format!("evt_prompt_{chat}_{client}"),
                payload,
            )
            .await?;
        // A message can run in another mode than its chat's, as a schedule's does.
        if let Some(mode) = request.access_mode.as_ref().and_then(Value::as_str) {
            envelope.access_mode = Some(mode.to_owned());
        }
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
