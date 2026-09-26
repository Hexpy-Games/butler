//! Concrete per-execution composition over the retained native domain owners.

mod authority;
mod surface;

#[cfg(test)]
mod tests;

use std::path::PathBuf;
use std::sync::Arc;

use crate::btcc::{
    AgentLoopProgress, BoundGuidedTurn, BtccError, BtccRepositories, ContextCompactionRepository,
    EffectJournal, GuidedPolicyDependencies, GuidedTurnFactory, GuidedTurnInputs, GuidedTurnStart,
    ModelRoundPort, PortFuture,
};
use crate::capabilities::NativeCapabilities;
use crate::cognition::{
    CognitionPathEnvironment, CompletionPublisher, NativeExactMemoryQuery, NativeMemoryRecall,
};
use crate::context::{NativeContextPort, NativeConversationSessionReference};
use crate::conversation::CanonicalMemoryReadBinding;

use super::{
    GuidedTextState, GuidedToolBinding, NativeGuidedActivity, NativeGuidedJournal,
    NativeGuidedPreparation, NativeGuidedPrompt, NativeGuidedSteering, NativeGuidedTools,
    NativeGuidedWork, NativeGuidedWorkTools, PreparedNativeGuidedTurn,
    resolve_guided_response_language,
};

/// All fields are process services or immutable host configuration, never Turn state.
pub(crate) struct NativeGuidedTurnFactory {
    pub preparation: NativeGuidedPreparation,
    pub documents: BtccRepositories,
    pub effects: Arc<dyn EffectJournal>,
    pub capabilities: Arc<NativeCapabilities>,
    pub command: Arc<super::guided_command::NativeGuidedCommand>,
    pub project_tools: Arc<super::guided_project_tools::NativeGuidedProjectTools>,
    pub tool_artifacts: Arc<super::NativeToolArtifactReader>,
    pub memory_query: Arc<NativeExactMemoryQuery>,
    pub memory_recall: Arc<NativeMemoryRecall>,
    pub memory_paths: CognitionPathEnvironment,
    pub memory_publisher: Arc<CompletionPublisher>,
    pub conversation_reference: Arc<NativeConversationSessionReference>,
    pub conversation_tools: Arc<crate::context::NativeConversationTools>,
    pub compactions: ContextCompactionRepository,
    pub attachment_context: Arc<crate::context::NativeAttachmentContext>,
    pub verified_image_payload: Arc<dyn crate::btcc::VerifiedImagePayloadPort>,
    pub butler_data: PathBuf,
    pub installation_root: PathBuf,
    pub protected_ledger_roots: Vec<PathBuf>,
    pub subsessions: Arc<crate::btcc::NativeSubsessionService>,
    pub work_streams: Arc<super::NativeWorkStreams>,
    pub automations: Arc<crate::operations::NativeAutomationService>,
    pub mcp_client: Arc<crate::mcp_client::NativeMcpClient>,
    pub profile: Arc<crate::profile::ProfileService>,
    pub monitoring: Arc<super::MonitoringReaders>,
    pub session_worktrees: crate::workspace::NativeSessionWorktrees,
    pub web_access: Arc<crate::web_access::WebAccess>,
    pub app_endpoint: Arc<super::NativeActiveAppEndpoint>,
}

struct NativeBoundTurn<'a> {
    inputs: Option<GuidedTurnInputs>,
    progress: &'a dyn AgentLoopProgress,
    base: &'a dyn ModelRoundPort,
}

impl BoundGuidedTurn for NativeBoundTurn<'_> {
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

impl GuidedTurnFactory for NativeGuidedTurnFactory {
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
            if phase.execution_policy.role == "steward"
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
            let work = Arc::new(NativeGuidedWork::new(
                self.preparation.work.clone(),
                work_scope.clone(),
                policy.tracking_mode.clone(),
                &policy.role,
                language.clone(),
                start.turn.original_message.clone(),
            )?);
            let workspace_path = workspace.get().map_err(|e| error(&e.code))?;
            let activity = Arc::new(NativeGuidedActivity::new(
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
            let tools = Arc::new(NativeGuidedTools::new(
                self.capabilities.clone(),
                self.command.clone(),
                self.tool_artifacts.clone(),
                Arc::new(crate::btcc::NativeEffectService::new(
                    self.effects.clone(),
                    Arc::new(|| {
                        crate::models::ModelConfigurationClock::now_iso(&super::SystemIdentity)
                    }),
                )),
                self.effects.clone(),
                self.preparation.authority.clone(),
                super::NativeGuidedFileEffects::new(
                    self.capabilities.clone(),
                    super::RegisteredWriteContext {
                        workspace_reference: Some(workspace.clone()),
                        workspace_path: workspace_path.clone(),
                        butler_data: self.butler_data.clone(),
                        protected_ledger_roots: self.protected_ledger_roots.clone(),
                        allowed_tools_and_effects: None,
                        mutation_scope: None,
                        installation_root: Some(self.installation_root.clone()),
                    },
                    crate::workspace::EffectFileScope {
                        workspace: workspace_path.clone(),
                        butler_data: self.butler_data.clone(),
                        protected_roots: self.protected_ledger_roots.clone(),
                        installation_root: Some(self.installation_root.clone()),
                    },
                ),
                self.memory_query.clone(),
                self.memory_recall.clone(),
                self.memory_paths.clone(),
                self.memory_publisher.clone(),
                self.conversation_reference.clone(),
                self.conversation_tools.clone(),
                self.project_tools.clone(),
                NativeGuidedWorkTools::new(self.preparation.work.clone(), work_scope.clone()),
                activity.clone(),
                self.preparation.journal.clone(),
                self.preparation.catalog.clone(),
                self.subsessions.clone(),
                self.work_streams.clone(),
                self.automations.clone(),
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
                        != crate::btcc::AccessMode::ReadOnly
                        && policy.tracking_mode == "ledger"
                        && policy.project_id.is_some(),
                    owner_session_id: start.turn.session_id.clone(),
                    source_session_id: start.turn.session_id.clone(),
                    model_ref: format!("{}/{}", semantic.model.provider, semantic.model.model),
                    reasoning_effort: serde_json::to_value(&semantic.model.reasoning_effort)
                        .map_err(|_| error("invalid_reasoning_effort"))?
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
                        project_id: policy.project_id.clone().or_else(|| {
                            start
                                .turn
                                .context
                                .get("projectRef")
                                .and_then(serde_json::Value::as_str)
                                .map(str::to_owned)
                        }),
                    },
                    project_id: policy.project_id.clone(),
                    project_sources: start
                        .turn
                        .context
                        .get("projectSources")
                        .and_then(serde_json::Value::as_array)
                        .cloned()
                        .unwrap_or_default(),
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
            let journal = Arc::new(NativeGuidedJournal::new(
                start.turn.turn_id.clone(),
                self.preparation.journal.clone(),
                activity.clone(),
            ));
            let text = Arc::new(GuidedTextState {
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
            let prompt = Arc::new(NativeGuidedPrompt::new(text.clone()));
            let steering = Arc::new(NativeGuidedSteering::new(
                text,
                self.subsessions.clone(),
                start.turn.session_id.clone(),
                start.turn.turn_id.clone(),
            ));
            let context = Arc::new(NativeContextPort::new(
                steering,
                Some(self.compactions.clone()),
            ));
            let authority = Arc::new(authority::NativeBoundAuthority::new(
                start.turn.turn_id.clone(),
                activity,
            ));
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
                    stream_observer: None,
                    identity_observer: None,
                },
                authority_decision,
                operation_results,
                budget,
                source_revision,
            };
            Ok(Box::new(NativeBoundTurn {
                inputs: Some(inputs),
                progress: start.progress,
                base: start.base,
            }) as Box<dyn BoundGuidedTurn + 'a>)
        })
    }
}

fn error(code: &str) -> BtccError {
    BtccError::new(code, code)
}
