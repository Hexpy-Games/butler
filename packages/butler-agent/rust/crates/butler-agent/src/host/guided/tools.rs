//! Per-Turn native tool binding. Durable results live in ToolJournalRepository,
//! while this owner keeps only occurrence counters and provider-call mapping.

mod discovery;
mod dispatch;
mod effect;
mod execute;
mod image;
mod memory_write;
mod message;
mod monitoring;
mod occurrence;
pub(in crate::host) use monitoring::MonitoringReaders;
mod profile;
mod project_source;
mod resume;
pub(in crate::host) use message::structured_raw as structured_tool_preview;

use crate::tool_protocol::ToolName;
use parking_lot::Mutex;
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::Value;

use crate::btcc::ToolJournalRepository;
use crate::btcc::{
    AuthorityLoopContinuation, BtccError, GuidedInvocation, ModelRoundMessage, ModelRoundTool,
    ModelRoundToolCall, PortFuture, ToolExecutionError, ToolPort, ToolResult, TurnRecord,
};
use crate::capabilities::Capabilities;
use crate::cognition::{ExactMemoryQuery, MemoryRecall};
use crate::context::ConversationSessionReference;
use crate::conversation::CanonicalMemoryReadBinding;
use crate::host::{GuidedActivity, GuidedWorkTools};
use crate::workspace::WorkspaceReference;
use resume::ResumePool;
use tokio::sync::OnceCell;

pub(crate) struct GuidedToolBinding {
    pub turn_id: String,
    pub app_session_id: Option<String>,
    pub access_mode: crate::btcc::AccessMode,
    pub enable_project_ledger_effects: bool,
    pub current_user_message: String,
    pub memory: CanonicalMemoryReadBinding,
    pub project_id: Option<String>,
    pub project_sources: Vec<Value>,
    pub surface: Vec<ModelRoundTool>,
    pub authorized_names: HashSet<String>,
    pub visible_names: HashSet<String>,
    pub required_names: HashSet<String>,
    pub workspace_reference: Option<WorkspaceReference>,
    pub workspace_path: PathBuf,
    pub butler_data: PathBuf,
    pub protected_ledger_roots: Vec<PathBuf>,
    pub allowed_tools_and_effects: Option<Vec<String>>,
    pub mutation_scope: Option<Vec<String>>,
    pub installation_root: Option<PathBuf>,
    pub owner_session_id: String,
    pub source_session_id: String,
    pub model_ref: String,
    pub reasoning_effort: String,
    pub authority_request_ref: Option<String>,
    pub authority_source_call_id: Option<String>,
}

#[derive(Default)]
struct State {
    next_call_index: u64,
    journal_by_provider: HashMap<String, String>,
    described_ids: HashSet<String>,
}

pub(crate) struct GuidedTools {
    capabilities: Arc<Capabilities>,
    command: Arc<crate::host::guided::command::GuidedCommand>,
    tool_artifacts: Arc<crate::host::ToolArtifactReader>,
    effects: Arc<crate::btcc::EffectService>,
    authority: Arc<crate::btcc::PrincipalAuthority>,
    effect_journal: Arc<dyn crate::btcc::EffectJournal>,
    file_effects: crate::host::GuidedFileEffects,
    query: Arc<ExactMemoryQuery>,
    recall: Arc<MemoryRecall>,
    memory_paths: crate::cognition::CognitionPathEnvironment,
    memory_publisher: Arc<crate::cognition::CompletionPublisher>,
    conversations: Arc<ConversationSessionReference>,
    conversation_tools: Arc<crate::context::ConversationTools>,
    project: Arc<crate::host::guided::project_tools::GuidedProjectTools>,
    work: GuidedWorkTools,
    activity: Arc<GuidedActivity>,
    journal: Arc<ToolJournalRepository>,
    catalog: Arc<crate::host::GuidedCatalog>,
    subsessions: Arc<crate::btcc::SubsessionService>,
    work_streams: Arc<crate::host::WorkStreams>,
    automations: Arc<crate::operations::AutomationService>,
    mcp_client: Arc<crate::mcp_client::McpClient>,
    verified_image_payload: Arc<dyn crate::btcc::VerifiedImagePayloadPort>,
    profile: Arc<crate::profile::ProfileService>,
    monitoring: Arc<MonitoringReaders>,
    attachment_context: Arc<crate::context::AttachmentContext>,
    session_worktrees: crate::workspace::SessionWorktrees,
    web_session: crate::web_access::WebSession,
    app_endpoint: Arc<crate::host::ActiveAppEndpoint>,
    binding: GuidedToolBinding,
    state: Mutex<State>,
    resume: OnceCell<Mutex<ResumePool>>,
    authority_consumed: Mutex<bool>,
}

/// A guided tool invocation that violated its contract; becomes a BTCC error.
#[derive(Debug, thiserror::Error)]
#[error("{code}: {message}")]
pub(in crate::host) struct GuidedToolError {
    code: &'static str,
    message: String,
    #[source]
    source: Option<Box<dyn std::error::Error + Send + Sync>>,
}
impl GuidedToolError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            source: None,
        }
    }
    /// Records the underlying error.
    #[must_use]
    fn with_source(mut self, source: impl std::error::Error + Send + Sync + 'static) -> Self {
        self.source = Some(Box::new(source));
        self
    }
    fn contract(self) -> BtccError {
        let (code, message) = (self.code, self.message.clone());
        BtccError::relay(code, message, self)
    }
}

impl GuidedTools {
    #[expect(
        clippy::too_many_arguments,
        reason = "composition explicitly requires independently owned tool, authority, and lifecycle collaborators"
    )]
    pub(crate) fn new(
        capabilities: Arc<Capabilities>,
        command: Arc<crate::host::guided::command::GuidedCommand>,
        tool_artifacts: Arc<crate::host::ToolArtifactReader>,
        effects: Arc<crate::btcc::EffectService>,
        effect_journal: Arc<dyn crate::btcc::EffectJournal>,
        authority: Arc<crate::btcc::PrincipalAuthority>,
        file_effects: crate::host::GuidedFileEffects,
        query: Arc<ExactMemoryQuery>,
        recall: Arc<MemoryRecall>,
        memory_paths: crate::cognition::CognitionPathEnvironment,
        memory_publisher: Arc<crate::cognition::CompletionPublisher>,
        conversations: Arc<ConversationSessionReference>,
        conversation_tools: Arc<crate::context::ConversationTools>,
        project: Arc<crate::host::guided::project_tools::GuidedProjectTools>,
        work: GuidedWorkTools,
        activity: Arc<GuidedActivity>,
        journal: Arc<ToolJournalRepository>,
        catalog: Arc<crate::host::GuidedCatalog>,
        subsessions: Arc<crate::btcc::SubsessionService>,
        work_streams: Arc<crate::host::WorkStreams>,
        automations: Arc<crate::operations::AutomationService>,
        mcp_client: Arc<crate::mcp_client::McpClient>,
        verified_image_payload: Arc<dyn crate::btcc::VerifiedImagePayloadPort>,
        profile: Arc<crate::profile::ProfileService>,
        monitoring: Arc<MonitoringReaders>,
        attachment_context: Arc<crate::context::AttachmentContext>,
        session_worktrees: crate::workspace::SessionWorktrees,
        web_session: crate::web_access::WebSession,
        app_endpoint: Arc<crate::host::ActiveAppEndpoint>,
        restored: Option<&AuthorityLoopContinuation>,
        binding: GuidedToolBinding,
    ) -> Result<Self, BtccError> {
        for name in binding
            .required_names
            .iter()
            .chain(binding.visible_names.iter())
            .chain(binding.authorized_names.iter())
        {
            if !Self::supports(name) {
                return Err(BtccError::relayed(
                    "guided_tool_executor_missing",
                    format!("No native executor is registered for {name}"),
                ));
            }
        }
        for tool in &binding.surface {
            if !binding.visible_names.contains(&tool.name) {
                return Err(BtccError::relayed(
                    "guided_tool_surface_not_visible",
                    format!("Selected tool {} is not visible", tool.name),
                ));
            }
        }
        let described_ids = restored
            .into_iter()
            .flat_map(|continuation| &continuation.messages)
            .flat_map(|message| message.tool_calls.as_deref().unwrap_or(&[]))
            .filter(|call| call.name == ToolName::ToolCall)
            .filter_map(|call| call.arguments.get("id").and_then(Value::as_str))
            .map(str::to_owned)
            .collect();
        Ok(Self {
            capabilities,
            command,
            tool_artifacts,
            effects,
            authority,
            effect_journal,
            file_effects,
            query,
            recall,
            memory_paths,
            memory_publisher,
            conversations,
            conversation_tools,
            project,
            work,
            activity,
            journal,
            catalog,
            subsessions,
            work_streams,
            automations,
            mcp_client,
            verified_image_payload,
            profile,
            monitoring,
            attachment_context,
            session_worktrees,
            web_session,
            app_endpoint,
            binding,
            state: Mutex::new(State {
                described_ids,
                ..State::default()
            }),
            resume: OnceCell::new(),
            authority_consumed: Mutex::new(false),
        })
    }

    pub(crate) fn supports(name: &str) -> bool {
        matches!(
            ToolName::parse(name),
            Some(
                ToolName::ReadFile
                    | ToolName::RunCommand
                    | ToolName::WriteFile
                    | ToolName::EditFile
                    | ToolName::GrepFiles
                    | ToolName::ReadToolOutputArtifact
                    | ToolName::ReadToolEvidenceArtifact
                    | ToolName::ListFiles
                    | ToolName::ListSkills
                    | ToolName::ListOperationResults
                    | ToolName::ReadOperationResults
                    | ToolName::QueryMemory
                    | ToolName::RecallMemory
                    | ToolName::IngestTaskMemory
                    | ToolName::UpdateExplicitMemory
                    | ToolName::AnalyzeAttachedImage
                    | ToolName::ReadConversationSession
                    | ToolName::ListConversationSessions
                    | ToolName::ReadConversationContext
                    | ToolName::ToolSearch
                    | ToolName::ToolDescribe
                    | ToolName::ToolCall
                    | ToolName::ListMcpCapabilities
                    | ToolName::SummarizeUserProfile
                    | ToolName::UpdateOnboardingProfile
                    | ToolName::ReadProjectSource
                    | ToolName::BindSessionGitWorktree
                    | ToolName::StartTopicConversation
                    | ToolName::RequestServiceRestart
                    | ToolName::CallMcpTool
                    | ToolName::ReadMcpResource
                    | ToolName::DelegateToSteward
                    | ToolName::DelegateToWorker
                    | ToolName::SteerSteward
                    | ToolName::SteerWorker
                    | ToolName::CancelSteward
                    | ToolName::WaitForWorker
                    | ToolName::UpdateTodoList
                    | ToolName::ListTodoList
                    | ToolName::GetContextMonitor
                    | ToolName::GetUsageMonitor
                    | ToolName::GetMemoryHealth
                    | ToolName::ListToolCapabilities
                    | ToolName::ListWorkStreams
                    | ToolName::UpdateWorkStreamState
                    | ToolName::CreateAutomation
                    | ToolName::ListAutomations
                    | ToolName::DeleteAutomation
                    | ToolName::RunDueAutomations
                    | ToolName::WebSearch
                    | ToolName::WebRead
            )
        ) || GuidedWorkTools::is_work_tool(name)
            || crate::host::guided::project_tools::GuidedProjectTools::supports(name)
    }

    async fn resume_pool(&self) -> Result<&Mutex<ResumePool>, BtccError> {
        self.resume
            .get_or_try_init(|| async {
                let signatures = self
                    .journal
                    .list_signatures(self.binding.turn_id.clone())
                    .await
                    .map_err(BtccError::from)?;
                Ok(Mutex::new(ResumePool::new(signatures)?))
            })
            .await
    }
}

impl ToolPort for GuidedTools {
    fn surface<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        _: &'a [ModelRoundTool],
        final_report: bool,
    ) -> PortFuture<'a, (Vec<ModelRoundTool>, Option<String>)> {
        Box::pin(async move {
            self.same_turn(invocation)?;
            if self.binding.visible_names.iter().any(|name| {
                matches!(
                    ToolName::parse(name.as_str()),
                    Some(ToolName::ListOperationResults | ToolName::ReadOperationResults)
                )
            }) && invocation.operation_results.is_none()
            {
                return Err(BtccError::relayed(
                    "operation_result_exact_read_unavailable",
                    "Exact result reader is not bound for this Turn",
                ));
            }
            self.resume_pool().await?;
            Ok((
                if final_report {
                    Vec::new()
                } else {
                    self.binding.surface.clone()
                },
                None,
            ))
        })
    }

    fn execute<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        call: &'a ModelRoundToolCall,
        _: Option<u8>,
    ) -> Pin<
        Box<dyn Future<Output = Result<crate::json::JsonDocument, ToolExecutionError>> + Send + 'a>,
    > {
        Box::pin(async move { Box::pin(execute::execute(self, invocation, call)).await })
    }

    fn record_unexecuted<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        call: &'a ModelRoundToolCall,
        result: &'a ToolResult,
    ) -> PortFuture<'a, ()> {
        Box::pin(async move { execute::record_unexecuted(self, invocation, call, result).await })
    }

    fn operation_result_call_id(&self, provider_call_id: &str) -> Option<String> {
        self.state
            .lock()
            .journal_by_provider
            .get(provider_call_id)
            .cloned()
    }

    fn result_message<'a>(
        &'a self,
        turn: &'a TurnRecord,
        result: &'a ToolResult,
        references: &'a crate::btcc::OperationResultMessageReferences,
    ) -> PortFuture<'a, ModelRoundMessage> {
        Box::pin(async move { message::result_message(self, turn, result, references) })
    }
}

impl GuidedTools {
    fn same_turn(&self, invocation: GuidedInvocation<'_>) -> Result<(), BtccError> {
        if invocation.turn.turn_id == self.binding.turn_id {
            Ok(())
        } else {
            Err(BtccError::relayed(
                "guided_tool_turn_mismatch",
                "Tool owner belongs to a different Turn",
            ))
        }
    }
}
