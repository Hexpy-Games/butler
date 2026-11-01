//! Admission lifecycle hooks, always outside the storage transaction.
use super::*;
use crate::gateway::MessageSendRequest;
use butler_core::hooks::{
    HookAttachment, HookBlock, HookContext, HookEnvelope, HookEvent, HookPayload, HookPort,
    ProjectHookLine, ProjectHookRequest, ProjectHookReview,
};
use rusqlite::params;
/// A failing hook blocked part of a running turn; the App names it in a toast.
pub(super) const BLOCKED_EVENT: &str = "hook.blocked";
impl AppApplication {
    /// Publishes each turn-time block by a failing hook as `hook.blocked`. A rejected
    /// send needs none: its own response names the hook.
    pub fn observe_hook_blocks(&self) {
        let Some(port) = &self.dependencies.hooks else {
            return;
        };
        let storage = self.storage.clone();
        let subscribers = self.subscribers.clone();
        let clock = self.dependencies.identity_clock.clone();
        port.observe_blocks(Arc::new(move |block: HookBlock| {
            let Ok(Value::Object(payload)) = serde_json::to_value(&block) else {
                return;
            };
            let (storage, subscribers, now) =
                (storage.clone(), subscribers.clone(), clock.now_iso());
            tokio::spawn(async move {
                let published = storage
                    .execute(move |db| {
                        events::append(db, &subscribers, BLOCKED_EVENT, None, payload, &now)
                            .map(drop)
                    })
                    .await;
                if let Err(error) = published {
                    tracing::warn!(event = "hook_block_not_published", %error);
                }
            });
        }));
    }
    pub(super) async fn session_start_hook(
        &self,
        id: String,
        source: &str,
    ) -> Result<(), GatewayApplicationError> {
        let Some(port) = &self.dependencies.hooks else {
            return Ok(());
        };
        let _ = port.reload().await;
        let review = self.project_review(&id, port).await;
        let hold = matches!(&review, ProjectHookReview::Undecided(request)
            if request.listens(HookEvent::SessionStart));
        let port = scoped(port, review);
        if !hold && !port.enabled(HookEvent::SessionStart, None) {
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
        if hold {
            port.hold_session_start(envelope.clone());
            if !port.enabled(HookEvent::SessionStart, None) {
                return Ok(());
            }
        }
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
        let port = scoped(port, self.project_review(chat, port).await);
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
    /// What adding a project asks: the hooks of its folder, if nobody answered for it.
    /// An unusable file, a saved answer or no hooks at all ask nothing.
    pub(super) async fn project_folder_question(
        &self,
        project_id: String,
    ) -> Result<Option<ProjectHookRequest>, GatewayApplicationError> {
        let project_dir = self
            .project_workspace_path(Some(project_id))
            .await
            .map_err(|_| public(404, "project_not_found", "Project not found."))?;
        let (Some(port), Some(project_dir)) = (&self.dependencies.hooks, project_dir) else {
            return Ok(None);
        };
        Ok(match port.review_project(project_dir, None).await {
            Ok(ProjectHookReview::Undecided(request)) => Some(*request),
            _ => None,
        })
    }

    /// Answers that question for the project's own folder. Only an open question can
    /// be answered, and the list goes through the same comparison as a card's: a file
    /// that changed saves nothing, and the first message asks about what is there.
    pub(super) async fn answer_project_folder(
        &self,
        project_id: String,
        hooks: Vec<ProjectHookLine>,
        trusted: bool,
    ) -> Result<(), GatewayApplicationError> {
        let Some(mut request) = self.project_folder_question(project_id).await? else {
            return Ok(());
        };
        let Some(port) = &self.dependencies.hooks else {
            return Ok(());
        };
        request.hooks = hooks;
        if let Err(failure) = port.decide_project(request, trusted).await {
            // Nothing is remembered, so nothing runs: the first message asks.
            tracing::warn!(event = "project_hook_answer_not_saved", error = %failure);
        }
        Ok(())
    }

    /// What the session's project folder holds right now. A failed lookup means
    /// its hooks do not run, and does not stop the send that asked.
    async fn project_review(&self, chat: &str, port: &Arc<dyn HookPort>) -> ProjectHookReview {
        let id = chat.to_owned();
        let session = self
            .storage
            .read(move |db| sessions::read_summary(db, &id))
            .await;
        let Ok(session) = session else {
            return ProjectHookReview::None;
        };
        let Ok(Some(project_dir)) = self.project_workspace_path(session.project_id).await else {
            return ProjectHookReview::None;
        };
        port.review_project(project_dir, Some(session.session_hint))
            .await
            .unwrap_or(ProjectHookReview::None)
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

/// The port to dispatch with: it holds project hooks only if their content was allowed.
fn scoped(port: &Arc<dyn HookPort>, review: ProjectHookReview) -> Arc<dyn HookPort> {
    match review {
        ProjectHookReview::Trusted(project) => project,
        ProjectHookReview::None | ProjectHookReview::Denied | ProjectHookReview::Undecided(_) => {
            port.clone()
        }
    }
}
