//! Concrete per-execution composition over the retained native domain owners.

mod authority;
mod surface;

#[cfg(test)]
mod tests;

use std::path::PathBuf;
use std::sync::Arc;

use butler_memory::cognition::{ExactMemoryQuery, MemoryRecall};
use butler_runtime::capabilities::Capabilities;
use butler_runtime::context::{ContextPortAdapter, ConversationSessionReference};
use butler_turn::btcc::{
    AgentLoopProgress, BoundGuidedTurn, BtccError, BtccRepositories, ContextCompactionRepository,
    EffectJournal, GuidedPolicyDependencies, GuidedTurnFactory, GuidedTurnInputs, GuidedTurnStart,
    ModelRoundPort, PortFuture,
};
use butler_turn::conversation::CanonicalMemoryReadBinding;

use crate::host::{
    GuidedActivity, GuidedJournal, GuidedPreparation, GuidedPrompt, GuidedSteering,
    GuidedTextState, GuidedToolBinding, GuidedTools, GuidedWorkAdapter, GuidedWorkTools,
    PreparedNativeGuidedTurn, resolve_guided_response_language,
};

/// All fields are process services or immutable host configuration, never Turn state.
pub(crate) struct GuidedTurnFactoryAdapter {
    pub preparation: GuidedPreparation,
    pub documents: BtccRepositories,
    pub effects: Arc<dyn EffectJournal>,
    pub capabilities: Arc<Capabilities>,
    pub command: Arc<crate::host::guided::command::GuidedCommand>,
    pub project_tools: Arc<crate::host::guided::project_tools::GuidedProjectTools>,
    pub tool_artifacts: Arc<crate::host::ToolArtifactReader>,
    pub memory_query: Arc<ExactMemoryQuery>,
    pub memory_recall: Arc<MemoryRecall>,
    pub memory_writes: super::tools::MemoryWriteServices,
    pub conversation_reference: Arc<ConversationSessionReference>,
    pub conversation_tools: Arc<butler_runtime::context::ConversationTools>,
    pub compactions: ContextCompactionRepository,
    pub attachment_context: Arc<butler_runtime::context::AttachmentContext>,
    pub verified_image_payload: Arc<dyn butler_turn::btcc::VerifiedImagePayloadPort>,
    pub butler_data: PathBuf,
    pub installation_root: PathBuf,
    pub protected_ledger_roots: Vec<PathBuf>,
    pub subsessions: Arc<butler_turn::btcc::SubsessionService>,
    pub work_streams: Arc<crate::host::WorkStreams>,
    pub mcp_client: Arc<butler_models::mcp_client::McpClient>,
    pub profile: Arc<butler_memory::profile::ProfileService>,
    pub monitoring: Arc<crate::host::MonitoringReaders>,
    pub session_worktrees: butler_turn::workspace::SessionWorktrees,
    pub web_access: Arc<butler_runtime::web_access::WebAccess>,
    pub app_endpoint: Arc<crate::host::ActiveAppEndpoint>,
}

struct BoundTurn<'a> {
    inputs: Option<GuidedTurnInputs>,
    progress: &'a dyn AgentLoopProgress,
    base: &'a dyn ModelRoundPort,
}

impl GuidedTurnFactoryAdapter {
    async fn skill_catalog(&self, project_id: Option<String>) -> Result<String, BtccError> {
        self.capabilities
            .compact_skill_catalog(project_id)
            .await
            .map_err(|cause| error(cause.code()))
    }
}

fn bound_project_id(project_id: Option<&str>, context: &serde_json::Value) -> Option<String> {
    project_id.map(str::to_owned).or_else(|| {
        context
            .get("projectRef")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
    })
}

impl BoundGuidedTurn for BoundTurn<'_> {
    fn take_inputs(&mut self) -> Result<GuidedTurnInputs, BtccError> {
        self.inputs
            .take()
            .ok_or_else(|| error("guided_turn_already_taken"))
    }
    fn progress(&self) -> &dyn AgentLoopProgress {
        self.progress
    }
    fn base(&self) -> &dyn ModelRoundPort {
        self.base
    }
}

impl GuidedTurnFactory for GuidedTurnFactoryAdapter {
    fn bind_pre_model<'a>(
        &'a self,
        start: GuidedTurnStart<'a>,
    ) -> PortFuture<'a, Box<dyn BoundGuidedTurn + 'a>> {
        Box::pin(async move {
            let PreparedNativeGuidedTurn {
                semantic,
                mut phase,
                workspace,
                accepted_plan,
                initial_work,
                work_scope,
                authority_decision,
                operation_results,
                budget,
                source_revision,
            } = self.preparation.prepare(&start).await?;
            if phase.execution_policy.role == butler_turn::btcc::PolicyRole::Steward
                && phase.provider_tools.iter().any(|tool| {
                    tool.get("name").and_then(serde_json::Value::as_str)
                        == Some("delegate_to_worker")
                })
            {
                let profiles = self.subsessions.enabled_worker_profiles().await?;
                surface::with_worker_profile_choices(&mut phase, &profiles)?;
            }
            let surface = surface::available(&mut phase, self.preparation.catalog.snapshot())?;
            let policy = &phase.execution_policy;
            let language = resolve_guided_response_language(start.turn, &self.documents).await;
            let (work, work_tools) =
                self.work_adapters(start.turn, &phase, &work_scope, language.clone())?;
            let workspace_path = workspace.get().map_err(|e| error(e.code()))?;
            let activity = Arc::new(GuidedActivity::new(
                start.turn.turn_id.clone(),
                source_revision.clone(),
                initial_work
                    .context
                    .as_ref()
                    .filter(|_| initial_work.bound)
                    .map(|context| &context.work),
            ));
            if let Some(saved) = semantic
                .authority
                .as_ref()
                .and_then(|value| value.presentation.as_ref())
            {
                activity.restore(&saved.activity)?;
            }
            let tools = Arc::new(GuidedTools::new(
                self.capabilities.clone(),
                self.command.clone(),
                self.tool_artifacts.clone(),
                Arc::new(butler_turn::btcc::EffectService::new(
                    self.effects.clone(),
                    Arc::new(|| {
                        butler_models::models::ModelConfigurationClock::now_iso(
                            &crate::host::SystemIdentity,
                        )
                    }),
                )),
                self.effects.clone(),
                self.preparation.authority.clone(),
                crate::host::GuidedFileEffects::new(
                    self.capabilities.clone(),
                    crate::host::RegisteredWriteContext {
                        workspace_reference: Some(workspace.clone()),
                        workspace_path: workspace_path.clone(),
                        butler_data: self.butler_data.clone(),
                        protected_ledger_roots: self.protected_ledger_roots.clone(),
                        allowed_tools_and_effects: None,
                        mutation_scope: None,
                        installation_root: Some(self.installation_root.clone()),
                    },
                    butler_turn::workspace::EffectFileScope {
                        workspace: workspace_path.clone(),
                        butler_data: self.butler_data.clone(),
                        protected_roots: self.protected_ledger_roots.clone(),
                        installation_root: Some(self.installation_root.clone()),
                    },
                ),
                self.memory_query.clone(),
                self.memory_recall.clone(),
                self.memory_writes.clone(),
                self.conversation_reference.clone(),
                self.conversation_tools.clone(),
                self.project_tools.clone(),
                work_tools,
                activity.clone(),
                self.preparation.journal.clone(),
                self.preparation.catalog.clone(),
                self.subsessions.clone(),
                self.work_streams.clone(),
                self.mcp_client.clone(),
                self.verified_image_payload.clone(),
                self.profile.clone(),
                self.monitoring.clone(),
                self.attachment_context.clone(),
                self.session_worktrees.clone(),
                self.web_access
                    .session_for_turn(start.turn.original_message.clone()),
                self.app_endpoint.clone(),
                semantic.authority.as_ref(),
                GuidedToolBinding {
                    turn_id: start.turn.turn_id.clone(),
                    app_session_id: start
                        .turn
                        .context
                        .get("appSessionId")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_owned),
                    access_mode: policy.access_mode.clone(),
                    enable_project_ledger_effects: policy.access_mode
                        != butler_turn::btcc::AccessMode::ReadOnly
                        && policy.tracking_mode == "ledger"
                        && policy.project_id.is_some(),
                    owner_session_id: start.turn.session_id.clone(),
                    source_session_id: start.turn.session_id.clone(),
                    model_ref: format!("{}/{}", semantic.model.provider, semantic.model.model),
                    reasoning_effort: serde_json::to_value(&semantic.model.reasoning_effort)
                        .map_err(|source| error("invalid_reasoning_effort").with_source(source))?
                        .as_str()
                        .ok_or_else(|| error("invalid_reasoning_effort"))?
                        .to_owned(),
                    authority_request_ref: semantic.context.authority_request_ref.clone(),
                    authority_source_call_id: semantic
                        .authority
                        .as_ref()
                        .map(|cursor| cursor.call_id.clone()),
                    current_user_message: start.turn.original_message.clone(),
                    memory: CanonicalMemoryReadBinding {
                        runtime_session_id: start.turn.session_id.clone(),
                        turn_id: start.turn.turn_id.clone(),
                        project_id: bound_project_id(
                            policy.project_id.as_deref(),
                            &start.turn.context,
                        ),
                    },
                    project_id: policy.project_id.clone(),
                    project_sources: project_sources(&start.turn.context),
                    visible_names: surface.iter().map(|t| t.name.clone()).collect(),
                    authorized_names: phase.authorized_names.iter().cloned().collect(),
                    required_names: policy.required_tools.iter().cloned().collect(),
                    surface,
                    workspace_reference: Some(workspace),
                    workspace_path,
                    butler_data: self.butler_data.clone(),
                    protected_ledger_roots: self.protected_ledger_roots.clone(),
                    allowed_tools_and_effects: None,
                    mutation_scope: None,
                    installation_root: Some(self.installation_root.clone()),
                },
            )?);
            let journal = Arc::new(GuidedJournal::new(
                start.turn.turn_id.clone(),
                self.preparation.journal.clone(),
                activity.clone(),
            ));
            let text = Arc::new(GuidedTextState {
                skill_catalog: self
                    .skill_catalog(phase.execution_policy.project_id.clone())
                    .await?,
                phase,
                work: initial_work,
                work_service: self.preparation.work.clone(),
                work_scope,
                documents: self.documents.clone(),
                journal: self.preparation.journal.clone(),
                attachment_context: self.attachment_context.clone(),
                effects: self.effects.clone(),
                accepted_plan,
                butler_data: self.butler_data.to_string_lossy().into_owned(),
                response_language: language,
                continuation_budget_enabled: budget.is_some(),
                work_streams: self.work_streams.clone(),
                subsessions: self.subsessions.clone(),
            });
            let prompt = Arc::new(GuidedPrompt::new(text.clone()));
            let steering = Arc::new(GuidedSteering::new(
                text,
                self.subsessions.clone(),
                start.turn.session_id.clone(),
                start.turn.turn_id.clone(),
            ));
            let context = Arc::new(ContextPortAdapter::new(
                steering,
                Some(self.compactions.clone()),
            ));
            let authority = Arc::new(authority::BoundAuthority::new(
                start.turn.turn_id.clone(),
                activity,
            ));
            let stream_relay = butler_turn::btcc::StreamRelay::new();
            let inputs = GuidedTurnInputs {
                semantic,
                dependencies: GuidedPolicyDependencies {
                    prompt,
                    authority,
                    context,
                    tools,
                    journal,
                    work,
                    verified_image_payload: Some(self.verified_image_payload.clone()),
                    stream_observer: Some(stream_relay.observer()),
                    identity_observer: None,
                },
                authority_decision,
                operation_results,
                budget,
                source_revision,
                stream_relay: Some(stream_relay),
            };
            Ok(Box::new(BoundTurn {
                inputs: Some(inputs),
                progress: start.progress,
                base: start.base,
            }) as Box<dyn BoundGuidedTurn + 'a>)
        })
    }
}

/// The App's project source references of the turn (`projectSources`).
fn project_sources(context: &serde_json::Value) -> Vec<serde_json::Value> {
    context
        .get("projectSources")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn error(code: &str) -> BtccError {
    BtccError::relayed(code.to_owned(), code)
}

impl GuidedTurnFactoryAdapter {
    // Both owners share the admitted tool grant; the model never authors that grant.
    fn work_adapters(
        &self,
        turn: &butler_turn::btcc::TurnRecord,
        phase: &butler_turn::btcc::GuidedPhaseSelection,
        scope: &butler_turn::btcc::WorkTurnScope,
        language: String,
    ) -> Result<(Arc<GuidedWorkAdapter>, GuidedWorkTools), BtccError> {
        let policy = &phase.execution_policy;
        let work = GuidedWorkAdapter::new(
            self.preparation.work.clone(),
            scope.clone(),
            policy.tracking_mode.clone(),
            policy.role.as_str(),
            language,
            turn.original_message.clone(),
        )?
        .with_capability_recovery(&phase.authorized_names, self.preparation.journal.clone());
        let tools = GuidedWorkTools::new(self.preparation.work.clone(), scope.clone())
            .with_child_tools(
                (policy.role.as_str() != "butler").then(|| phase.authorized_names.clone()),
            );
        Ok((Arc::new(work), tools))
    }
}
