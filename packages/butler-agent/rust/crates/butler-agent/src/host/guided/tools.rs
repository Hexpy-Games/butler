//! Per-Turn native tool binding. Durable results live in ToolJournalRepository,
//! while this owner keeps only occurrence counters and provider-call mapping.

mod access;
mod answer_blocks;
mod answer_blocks_stream;
pub(in crate::host::guided) use answer_blocks_stream::AnswerBlocksStream;
mod deliver;
mod direct_approval;
mod discovery;
mod dispatch;
#[cfg(test)]
pub(super) use dispatch::steward_gate::tests::assert_steward_mutation_predicate;
mod documents;
mod effect;
mod execute;
mod feedback;
mod folder;
mod hooks;
mod image;
mod image_gen;
mod library;
mod memory_write;
pub(crate) use memory_write::MemoryWriteServices;
mod browse;
mod browser;
mod message;
mod monitoring;
mod occurrence;
mod outputs;
mod question;
mod resolve_ask;
pub(in crate::host) use monitoring::MonitoringReaders;
mod attention;
mod profile;
mod project_artifacts;
mod project_source;
mod resume;
mod supported;
mod turn_guard;
mod wallpaper;
pub(in crate::host) use message::structured_raw as structured_tool_preview;
pub(crate) use turn_guard::TurnGuard;

use butler_core::tool_protocol::ToolName;
use parking_lot::Mutex;
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::Value;

use crate::host::{GuidedActivity, GuidedWorkTools};
use butler_memory::cognition::{ExactMemoryQuery, MemoryRecall};
use butler_runtime::capabilities::Capabilities;
use butler_runtime::context::ConversationSessionReference;
use butler_turn::btcc::{
    AuthorityLoopContinuation, BtccError, GuidedInvocation, LoopPhase, ModelRoundMessage,
    ModelRoundTool, ModelRoundToolCall, PortFuture, ToolExecutionError, ToolJournalRepository,
    ToolPort, ToolResult, ToolSurface, TurnRecord,
};
use butler_turn::conversation::CanonicalMemoryReadBinding;
use butler_turn::workspace::WorkspaceReference;
use resume::ResumePool;
use tokio::sync::OnceCell;

pub(crate) struct GuidedToolBinding {
    pub turn_id: String,
    pub(super) open_asks: Arc<Mutex<super::prompt::open_asks::Reminders>>,
    pub app_session_id: Option<String>,
    pub access_mode: butler_turn::btcc::AccessMode,
    pub enable_project_ledger_effects: bool,
    pub current_user_message: String,
    pub memory: CanonicalMemoryReadBinding,
    pub project_id: Option<String>,
    pub project_folder: Option<PathBuf>,
    pub project_sources: Vec<Value>,
    pub attachment_files: Vec<PathBuf>,
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
    /// Whether anyone can answer an approval (D8) and the starting taint (D5).
    pub turn_guard: TurnGuard,
}

impl GuidedToolBinding {
    /// Whether project ledger effects are enabled for this turn.
    pub(crate) fn ledger_effects(&self) -> butler_turn::btcc::LedgerEffects {
        if self.enable_project_ledger_effects {
            butler_turn::btcc::LedgerEffects::Enabled
        } else {
            butler_turn::btcc::LedgerEffects::Disabled
        }
    }

    fn validate_surface(&self) -> Result<(), BtccError> {
        for name in self
            .required_names
            .iter()
            .chain(self.visible_names.iter())
            .chain(self.authorized_names.iter())
        {
            if !GuidedTools::supports(name) {
                return Err(BtccError::relayed(
                    "guided_tool_executor_missing",
                    format!("No native executor is registered for {name}"),
                ));
            }
        }
        for tool in &self.surface {
            if !self.visible_names.contains(&tool.name) {
                return Err(BtccError::relayed(
                    "guided_tool_surface_not_visible",
                    format!("Selected tool {} is not visible", tool.name),
                ));
            }
        }
        Ok(())
    }
}

#[derive(Default)]
struct State {
    next_call_index: u64,
    output_checks: u8,
    /// Any result other than resolve_ask has entered this turn.
    has_other_tool_result: bool,
    answer_blocks: Vec<Value>,
    output_images: u8,
    journal_by_provider: HashMap<String, String>,
    described_ids: HashSet<String>,
    /// Per tab, the observation view the model holds (observation text v2).
    browser_views: HashMap<String, browser::TabView>,
}

pub(crate) struct GuidedTools {
    capabilities: Arc<Capabilities>,
    command: Arc<crate::host::guided::command::GuidedCommand>,
    tool_artifacts: Arc<crate::host::ToolArtifactReader>,
    effects: Arc<butler_turn::btcc::EffectService>,
    authority: Arc<butler_turn::btcc::PrincipalAuthority>,
    effect_journal: Arc<dyn butler_turn::btcc::EffectJournal>,
    file_effects: crate::host::GuidedFileEffects,
    query: Arc<ExactMemoryQuery>,
    recall: Arc<MemoryRecall>,
    memory_writes: MemoryWriteServices,
    conversations: Arc<ConversationSessionReference>,
    conversation_tools: Arc<butler_runtime::context::ConversationTools>,
    project: Arc<crate::host::guided::project_tools::GuidedProjectTools>,
    work: GuidedWorkTools,
    activity: Arc<GuidedActivity>,
    journal: Arc<ToolJournalRepository>,
    catalog: Arc<crate::host::GuidedCatalog>,
    subsessions: Arc<butler_turn::btcc::SubsessionService>,
    work_streams: Arc<crate::host::WorkStreams>,
    mcp_client: Arc<butler_models::mcp_client::McpClient>,
    verified_image_payload: Arc<dyn butler_turn::btcc::VerifiedImagePayloadPort>,
    profile: Arc<butler_memory::profile::ProfileService>,
    monitoring: Arc<MonitoringReaders>,
    attachment_context: Arc<butler_runtime::context::AttachmentContext>,
    session_worktrees: butler_turn::workspace::SessionWorktrees,
    web_session: butler_runtime::web_access::WebSession,
    app_endpoint: Arc<crate::host::ActiveAppEndpoint>,
    browser_http: OnceCell<butler_log::http::Client>,
    binding: GuidedToolBinding,
    state: Mutex<State>,
    resume: OnceCell<Mutex<ResumePool>>,
    authority_consumed: Mutex<bool>,
    turn_taint: Mutex<butler_turn::btcc::TurnTaint>,
    attention_sent: Mutex<std::collections::HashSet<String>>,
    instruction_run: Mutex<Option<butler_turn::btcc::ScheduleRunContext>>,
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
        effects: Arc<butler_turn::btcc::EffectService>,
        effect_journal: Arc<dyn butler_turn::btcc::EffectJournal>,
        authority: Arc<butler_turn::btcc::PrincipalAuthority>,
        file_effects: crate::host::GuidedFileEffects,
        query: Arc<ExactMemoryQuery>,
        recall: Arc<MemoryRecall>,
        memory_writes: MemoryWriteServices,
        conversations: Arc<ConversationSessionReference>,
        conversation_tools: Arc<butler_runtime::context::ConversationTools>,
        project: Arc<crate::host::guided::project_tools::GuidedProjectTools>,
        work: GuidedWorkTools,
        activity: Arc<GuidedActivity>,
        journal: Arc<ToolJournalRepository>,
        catalog: Arc<crate::host::GuidedCatalog>,
        subsessions: Arc<butler_turn::btcc::SubsessionService>,
        work_streams: Arc<crate::host::WorkStreams>,
        mcp_client: Arc<butler_models::mcp_client::McpClient>,
        verified_image_payload: Arc<dyn butler_turn::btcc::VerifiedImagePayloadPort>,
        profile: Arc<butler_memory::profile::ProfileService>,
        monitoring: Arc<MonitoringReaders>,
        attachment_context: Arc<butler_runtime::context::AttachmentContext>,
        session_worktrees: butler_turn::workspace::SessionWorktrees,
        web_session: butler_runtime::web_access::WebSession,
        app_endpoint: Arc<crate::host::ActiveAppEndpoint>,
        restored: Option<&AuthorityLoopContinuation>,
        binding: GuidedToolBinding,
    ) -> Result<Self, BtccError> {
        binding.validate_surface()?;
        turn_guard::restore_web(&web_session, &binding.current_user_message, restored);
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
            memory_writes,
            conversations,
            conversation_tools,
            project,
            work,
            activity,
            journal,
            catalog,
            subsessions,
            work_streams,
            mcp_client,
            verified_image_payload,
            profile,
            monitoring,
            attachment_context,
            session_worktrees,
            web_session,
            app_endpoint,
            browser_http: OnceCell::new(),
            turn_taint: Mutex::new(binding.turn_guard.initial_taint),
            attention_sent: Mutex::new(Default::default()),
            instruction_run: Mutex::new(None),
            binding,
            state: Mutex::new(resume::restored_state(restored)),
            resume: OnceCell::new(),
            authority_consumed: Mutex::new(false),
        })
    }

    async fn resume_pool(&self) -> Result<&Mutex<ResumePool>, BtccError> {
        self.resume
            .get_or_try_init(|| async {
                let signatures = self
                    .journal
                    .list_signatures(self.binding.turn_id.clone())
                    .await
                    .map_err(BtccError::from)?;
                outputs::restore_output_checks(self, &signatures);
                Ok(Mutex::new(ResumePool::new(signatures)?))
            })
            .await
    }
}

impl ToolPort for GuidedTools {
    fn hook_tool_name<'a>(&self, call: &'a ModelRoundToolCall) -> std::borrow::Cow<'a, str> {
        hooks::name(call)
    }
    fn hook_tool_input<'a>(
        &self,
        call: &'a ModelRoundToolCall,
    ) -> &'a serde_json::Map<String, serde_json::Value> {
        hooks::input(call)
    }
    fn surface<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        _: &'a [ModelRoundTool],
        _: LoopPhase,
    ) -> PortFuture<'a, ToolSurface> {
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
            let tools = self.binding.surface.clone();
            let encoded = serde_json::to_string(&tools).map_err(|error| {
                BtccError::relayed("guided_tool_surface_invalid", error.to_string())
                    .with_source(error)
            })?;
            Ok(ToolSurface {
                tools,
                digest: Some(butler_turn::btcc::digest_identity(&encoded)),
            })
        })
    }

    fn execute<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        call: &'a ModelRoundToolCall,
        _: Option<u8>,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<butler_core::json::JsonDocument, ToolExecutionError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            self.refresh_instruction_context().await?;
            Box::pin(execute::execute(self, invocation, call)).await
        })
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

    fn continuation_extensions(&self) -> serde_json::Map<String, Value> {
        self.taint_extensions()
    }

    fn result_message<'a>(
        &'a self,
        turn: &'a TurnRecord,
        result: &'a ToolResult,
        references: &'a butler_turn::btcc::OperationResultMessageReferences,
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
