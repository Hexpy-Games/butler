//! Admission lifecycle hooks, always outside the storage transaction.
use super::*;
use crate::gateway::MessageSendRequest;
use butler_core::hooks::{HookAttachment, HookEnvelope, HookEvent, HookPayload};
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
        let _ = port
            .dispatch(envelope, self.dependencies.service_shutdown.child_token())
            .await;
        Ok(())
    }
    pub(super) async fn prompt_hook(
        &self,
        chat: &str,
        client: &str,
        request: &MessageSendRequest,
        inspected: &admission::Inspected,
    ) -> Result<(), GatewayApplicationError> {
        let Some(port) = &self.dependencies.hooks else {
            return Ok(());
        };
        let _ = port.reload().await;
        if !port.enabled(HookEvent::UserPromptSubmit, None) {
            return Ok(());
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
        if let Some(reason) = port
            .dispatch(envelope, self.dependencies.service_shutdown.child_token())
            .await
            .ok()
            .flatten()
        {
            return Err(public(422, "hook_blocked", &reason));
        }
        Ok(())
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
