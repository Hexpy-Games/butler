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
pub(super) use monitoring::MonitoringReaders;
mod profile;
mod project_source;
mod resume;
pub(in crate::host) use message::structured_raw as structured_tool_preview;

use parking_lot::Mutex;
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::Value;

use super::{NativeGuidedActivity, NativeGuidedWorkTools};
use crate::btcc::ToolJournalRepository;
use crate::btcc::{
    AuthorityLoopContinuation, BtccError, GuidedInvocation, ModelRoundMessage, ModelRoundTool,
    ModelRoundToolCall, PortFuture, ToolExecutionError, ToolPort, ToolResult, TurnRecord,
};
use crate::capabilities::NativeCapabilities;
use crate::cognition::{NativeExactMemoryQuery, NativeMemoryRecall};
use crate::context::NativeConversationSessionReference;
use crate::conversation::CanonicalMemoryReadBinding;
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

pub(crate) struct NativeGuidedTools {
    capabilities: Arc<NativeCapabilities>,
    command: Arc<super::guided_command::NativeGuidedCommand>,
    tool_artifacts: Arc<super::NativeToolArtifactReader>,
    effects: Arc<crate::btcc::NativeEffectService>,
    authority: Arc<crate::btcc::NativePrincipalAuthority>,
    effect_journal: Arc<dyn crate::btcc::EffectJournal>,
    file_effects: super::NativeGuidedFileEffects,
    query: Arc<NativeExactMemoryQuery>,
    recall: Arc<NativeMemoryRecall>,
    memory_paths: crate::cognition::CognitionPathEnvironment,
    memory_publisher: Arc<crate::cognition::CompletionPublisher>,
    conversations: Arc<NativeConversationSessionReference>,
    conversation_tools: Arc<crate::context::NativeConversationTools>,
    project: Arc<super::guided_project_tools::NativeGuidedProjectTools>,
    work: NativeGuidedWorkTools,
    activity: Arc<NativeGuidedActivity>,
    journal: Arc<ToolJournalRepository>,
    catalog: Arc<super::NativeGuidedCatalog>,
    subsessions: Arc<crate::btcc::NativeSubsessionService>,
    work_streams: Arc<super::NativeWorkStreams>,
    automations: Arc<crate::operations::NativeAutomationService>,
    mcp_client: Arc<crate::mcp_client::NativeMcpClient>,
    verified_image_payload: Arc<dyn crate::btcc::VerifiedImagePayloadPort>,
    profile: Arc<crate::profile::ProfileService>,
    monitoring: Arc<MonitoringReaders>,
    attachment_context: Arc<crate::context::NativeAttachmentContext>,
    session_worktrees: crate::workspace::NativeSessionWorktrees,
    web_session: crate::web_access::WebSession,
    app_endpoint: Arc<super::NativeActiveAppEndpoint>,
    binding: GuidedToolBinding,
    state: Mutex<State>,
    resume: OnceCell<Mutex<ResumePool>>,
    authority_consumed: Mutex<bool>,
}

pub(super) struct GuidedToolError {
    code: &'static str,
    message: String,
}
impl GuidedToolError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
    fn contract(self) -> BtccError {
        BtccError::new(self.code, self.message)
    }
}

impl NativeGuidedTools {
    #[expect(
        clippy::too_many_arguments,
        reason = "composition explicitly requires independently owned tool, authority, and lifecycle collaborators"
    )]
    pub(crate) fn new(
        capabilities: Arc<NativeCapabilities>,
        command: Arc<super::guided_command::NativeGuidedCommand>,
        tool_artifacts: Arc<super::NativeToolArtifactReader>,
        effects: Arc<crate::btcc::NativeEffectService>,
        effect_journal: Arc<dyn crate::btcc::EffectJournal>,
        authority: Arc<crate::btcc::NativePrincipalAuthority>,
        file_effects: super::NativeGuidedFileEffects,
        query: Arc<NativeExactMemoryQuery>,
        recall: Arc<NativeMemoryRecall>,
        memory_paths: crate::cognition::CognitionPathEnvironment,
        memory_publisher: Arc<crate::cognition::CompletionPublisher>,
        conversations: Arc<NativeConversationSessionReference>,
        conversation_tools: Arc<crate::context::NativeConversationTools>,
        project: Arc<super::guided_project_tools::NativeGuidedProjectTools>,
        work: NativeGuidedWorkTools,
        activity: Arc<NativeGuidedActivity>,
        journal: Arc<ToolJournalRepository>,
        catalog: Arc<super::NativeGuidedCatalog>,
        subsessions: Arc<crate::btcc::NativeSubsessionService>,
        work_streams: Arc<super::NativeWorkStreams>,
        automations: Arc<crate::operations::NativeAutomationService>,
        mcp_client: Arc<crate::mcp_client::NativeMcpClient>,
        verified_image_payload: Arc<dyn crate::btcc::VerifiedImagePayloadPort>,
        profile: Arc<crate::profile::ProfileService>,
        monitoring: Arc<MonitoringReaders>,
        attachment_context: Arc<crate::context::NativeAttachmentContext>,
        session_worktrees: crate::workspace::NativeSessionWorktrees,
        web_session: crate::web_access::WebSession,
        app_endpoint: Arc<super::NativeActiveAppEndpoint>,
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
                return Err(BtccError::new(
                    "guided_tool_executor_missing",
                    format!("No native executor is registered for {name}"),
                ));
            }
        }
        for tool in &binding.surface {
            if !binding.visible_names.contains(&tool.name) {
                return Err(BtccError::new(
                    "guided_tool_surface_not_visible",
                    format!("Selected tool {} is not visible", tool.name),
                ));
            }
        }
        let described_ids = restored
            .into_iter()
            .flat_map(|continuation| &continuation.messages)
            .flat_map(|message| message.tool_calls.as_deref().unwrap_or(&[]))
            .filter(|call| call.name == "tool_call")
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
            name,
            "read_file"
                | "run_command"
                | "write_file"
                | "edit_file"
                | "grep_files"
                | "read_tool_output_artifact"
                | "read_tool_evidence_artifact"
                | "list_files"
                | "list_skills"
                | "list_operation_results"
                | "read_operation_results"
                | "query_memory"
                | "recall_memory"
                | "ingest_task_memory"
                | "update_explicit_memory"
                | "analyze_attached_image"
                | "read_conversation_session"
                | "list_conversation_sessions"
                | "read_conversation_context"
                | "tool_search"
                | "tool_describe"
                | "tool_call"
                | "list_mcp_capabilities"
                | "summarize_user_profile"
                | "update_onboarding_profile"
                | "read_project_source"
                | "bind_session_git_worktree"
                | "start_topic_conversation"
                | "request_service_restart"
                | "call_mcp_tool"
                | "read_mcp_resource"
                | "delegate_to_steward"
                | "delegate_to_worker"
                | "steer_steward"
                | "steer_worker"
                | "cancel_steward"
                | "wait_for_worker"
                | "update_todo_list"
                | "list_todo_list"
                | "get_context_monitor"
                | "get_usage_monitor"
                | "get_memory_health"
                | "list_tool_capabilities"
                | "list_work_streams"
                | "update_work_stream_state"
                | "create_automation"
                | "list_automations"
                | "delete_automation"
                | "run_due_automations"
                | "web_search"
                | "web_read"
        ) || NativeGuidedWorkTools::is_work_tool(name)
            || super::guided_project_tools::NativeGuidedProjectTools::supports(name)
    }

    async fn resume_pool(&self) -> Result<&Mutex<ResumePool>, BtccError> {
        self.resume
            .get_or_try_init(|| async {
                let signatures = self
                    .journal
                    .list_signatures(self.binding.turn_id.clone())
                    .await
                    .map_err(|error| BtccError::new(error.code, error.message))?;
                Ok(Mutex::new(ResumePool::new(signatures)?))
            })
            .await
    }
}

impl ToolPort for NativeGuidedTools {
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
                    name.as_str(),
                    "list_operation_results" | "read_operation_results"
                )
            }) && invocation.operation_results.is_none()
            {
                return Err(BtccError::new(
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
        Box::pin(async move { execute::execute(self, invocation, call).await })
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

impl NativeGuidedTools {
    fn same_turn(&self, invocation: GuidedInvocation<'_>) -> Result<(), BtccError> {
        if invocation.turn.turn_id == self.binding.turn_id {
            Ok(())
        } else {
            Err(BtccError::new(
                "guided_tool_turn_mismatch",
                "Tool owner belongs to a different Turn",
            ))
        }
    }
}
