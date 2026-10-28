//! Completion-driven per-chat folds. No worker exists until a chat has work.
use crate::host::HostError;
use butler_memory::{
    cognition::{self, CompletionNotice},
    profile::ProfileService,
};
use butler_models::models::{
    ModelProvider, PromptUsageAttribution, ProviderPromptLifecycle, ProviderPromptPort,
    ProviderPromptRequest,
};
use butler_runtime::context::ContextBudgetOwner;
use butler_turn::{
    conversation::{AgentConversationStore, VisibleHistory},
    workspace::SessionBindingStore,
};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::Arc,
};
use tokio::{sync::Mutex, task::JoinSet};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct State {
    running: HashMap<String, bool>,
    failed_windows: HashMap<String, VisibleHistory>,
    deleted: HashSet<String>,
    jobs: JoinSet<()>,
    closed: bool,
}

pub(crate) struct Continuity {
    memory_root: PathBuf,
    data_root: PathBuf,
    conversations: AgentConversationStore,
    bindings: SessionBindingStore,
    budget: Arc<ContextBudgetOwner>,
    profile: Arc<ProfileService>,
    provider: Arc<ModelProvider>,
    state: Mutex<State>,
    stop: CancellationToken,
}

pub(crate) struct Owners {
    pub memory_root: PathBuf,
    pub data_root: PathBuf,
    pub conversations: AgentConversationStore,
    pub bindings: SessionBindingStore,
    pub budget: Arc<ContextBudgetOwner>,
    pub profile: Arc<ProfileService>,
    pub provider: Arc<ModelProvider>,
}

impl Continuity {
    pub(crate) fn new(owners: Owners) -> Arc<Self> {
        Arc::new(Self {
            memory_root: owners.memory_root,
            data_root: owners.data_root,
            conversations: owners.conversations,
            bindings: owners.bindings,
            budget: owners.budget,
            profile: owners.profile,
            provider: owners.provider,
            state: Mutex::new(State::default()),
            stop: CancellationToken::new(),
        })
    }

    pub(crate) async fn notify(self: &Arc<Self>, notice: CompletionNotice) {
        let mut state = self.state.lock().await;
        while state.jobs.try_join_next().is_some() {}
        let id = &notice.conversation_session_id;
        if state.closed || state.deleted.contains(id) {
            return;
        }
        if let Some(dirty) = state.running.get_mut(id) {
            *dirty = true;
            return;
        }
        state.running.insert(id.clone(), false);
        let owner = self.clone();
        state.jobs.spawn(async move {
            owner.run(notice).await;
        });
    }

    async fn run(&self, notice: CompletionNotice) {
        loop {
            let fresh = self
                .conversations
                .take_visible_history(&notice.conversation_session_id);
            let previous = self
                .state
                .lock()
                .await
                .failed_windows
                .remove(&notice.conversation_session_id);
            let visible = fresh.or(previous);
            let result = self.fold(&notice, visible.as_ref()).await;
            let mut state = self.state.lock().await;
            if let Err(error) = result {
                butler_core::diagnostic!("[chat-continuity] fold failed: {error}");
                if !state.closed
                    && !state.deleted.contains(&notice.conversation_session_id)
                    && let Some(visible) = visible
                {
                    state
                        .failed_windows
                        .insert(notice.conversation_session_id.clone(), visible);
                }
            }
            if !state.closed
                && !state.deleted.contains(&notice.conversation_session_id)
                && state.running.get(&notice.conversation_session_id) == Some(&true)
            {
                state
                    .running
                    .insert(notice.conversation_session_id.clone(), false);
            } else {
                state.running.remove(&notice.conversation_session_id);
                break;
            }
        }
    }

    async fn fold(
        &self,
        notice: &CompletionNotice,
        visible: Option<&VisibleHistory>,
    ) -> Result<(), HostError> {
        let root = self.memory_root.clone();
        let id = notice.conversation_session_id.clone();
        let mut summary =
            tokio::task::spawn_blocking(move || cognition::read_continuity(&root, &id))
                .await
                .map_err(failure)?
                .map_err(failure)?;
        loop {
            if self.stop.is_cancelled() {
                return Ok(());
            }
            let Some(binding) = self
                .bindings
                .get_by_session_id(&notice.runtime_session_id)
                .await
                .map_err(failure)?
            else {
                return Ok(());
            };
            let cap = butler_core::json::saturating_usize(
                self.budget
                    .snapshot()
                    .await
                    .map_err(failure)?
                    .default_recent_conversation_token_budget(Some(&binding.model_ref)),
            );
            let Some(batch) = self
                .conversations
                .read_continuity_batch(
                    &notice.conversation_session_id,
                    summary.through_seq,
                    cap,
                    visible,
                )
                .await
                .map_err(failure)?
            else {
                return Ok(());
            };
            let model = self.profile.read_extractor_model().await.map_err(failure)?;
            let text = self
                .summarize(
                    notice,
                    &model,
                    &cognition::continuity_prompt(&summary.text, &batch.turns),
                )
                .await?;
            summary = cognition::ContinuitySummary {
                through_seq: batch.through_seq,
                text,
            };
            if !self
                .publish(
                    &notice.conversation_session_id,
                    &summary,
                    &model.effective_model,
                )
                .await?
            {
                return Ok(());
            }
        }
    }

    async fn summarize(
        &self,
        notice: &CompletionNotice,
        model: &butler_memory::profile::ProfilingExtractorModelSnapshot,
        prompt: &str,
    ) -> Result<String, HostError> {
        let effort: butler_models::models::ReasoningEffort =
            serde_json::from_value(serde_json::Value::String(model.reasoning_effort.clone()))
                .map_err(failure)?;
        let root = self.data_root.to_string_lossy();
        let attribution = PromptUsageAttribution {
            root_session_id: Some(&notice.runtime_session_id),
            ..PromptUsageAttribution::for_phase("chat_continuity")
        };
        let reply = self
            .provider
            .run_prompt(
                ProviderPromptRequest {
                    prompt,
                    model: Some(&model.effective_model),
                    reasoning_effort: Some(&effort),
                    instructions: Some(cognition::CONTINUITY_INSTRUCTIONS),
                    response_format: None,
                    cache_scope: Some("chat-continuity"),
                    cache_boundary: None,
                    cancellation: self.stop.child_token(),
                    attachments: &[],
                    butler_data: Some(&root),
                    usage_attribution: Some(&attribution),
                    stream_observer: None,
                    provider_retry_attempts: None,
                },
                ProviderPromptLifecycle::none(),
            )
            .await
            .map_err(failure)?;
        if reply.text.trim().is_empty() {
            return Err(HostError::new("chat_continuity_empty_reply"));
        }
        Ok(reply.text)
    }

    async fn publish(
        &self,
        id: &str,
        summary: &cognition::ContinuitySummary,
        model: &str,
    ) -> Result<bool, HostError> {
        // Deletion and publication serialize through the same lock. A finished
        // provider call cannot recreate a deleted chat's file.
        let state = self.state.lock().await;
        if state.closed || state.deleted.contains(id) {
            return Ok(false);
        }
        let root = self.memory_root.clone();
        let id = id.to_owned();
        let summary = cognition::ContinuitySummary {
            through_seq: summary.through_seq,
            text: summary.text.clone(),
        };
        let model = model.to_owned();
        tokio::task::spawn_blocking(move || {
            cognition::write_continuity(&root, &id, &summary, &model)
        })
        .await
        .map_err(failure)?
        .map_err(failure)?;
        Ok(true)
    }

    pub(crate) async fn forget(&self, runtime_id: &str) -> Result<(), HostError> {
        let sessions = self
            .conversations
            .conversation_ids_for_external_session(runtime_id)
            .await
            .map_err(failure)?;
        let mut state = self.state.lock().await;
        for id in sessions {
            state.deleted.insert(id.clone());
            state.failed_windows.remove(&id);
            self.conversations.take_visible_history(&id);
            let root = self.memory_root.clone();
            tokio::task::spawn_blocking(move || cognition::remove_continuity(&root, &id))
                .await
                .map_err(failure)?
                .map_err(failure)?;
        }
        Ok(())
    }

    pub(crate) async fn close(&self) {
        let mut jobs = {
            let mut state = self.state.lock().await;
            state.closed = true;
            state.failed_windows.clear();
            self.stop.cancel();
            std::mem::take(&mut state.jobs)
        };
        while jobs.join_next().await.is_some() {}
    }
}

fn failure(error: impl std::error::Error + Send + Sync + 'static) -> HostError {
    HostError::new("chat_continuity_failed").with_source(error)
}
