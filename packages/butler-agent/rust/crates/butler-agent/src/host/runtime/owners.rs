//! Runtime owner shutdown after admission has stopped and Turn futures have drained.

use super::*;
use crate::host::service::shutdown_trace::measure;
use butler_runtime::skills::Skills;

pub(super) struct RuntimeOwners {
    pub(super) stores: RuntimeStores,
    pub(super) project_work: Arc<ProjectWork>,
    pub(super) project_tools: Arc<crate::host::guided::project_tools::GuidedProjectTools>,
    pub(super) session_worktrees: SessionWorktrees,
    pub(super) image_files: Arc<butler_gateway::gateway::AppImageFiles>,
    pub(super) attachment_context: Arc<butler_runtime::context::AttachmentContext>,
    pub(super) memory_sync: crate::host::memory_jobs::sync::MemorySync,
    pub(super) embedding: Arc<super::super::EmbeddingOwner>,
    pub(super) profile: Arc<ProfileService>,
    pub(super) cognition: Arc<CognitionPromptReader>,
    pub(super) memory_query: Arc<ExactMemoryQuery>,
    pub(super) memory_recall: Arc<MemoryRecall>,
    pub(super) conversation_reference: Arc<ConversationSessionReference>,
    pub(super) conversation_tools: Arc<ConversationTools>,
    pub(super) observer: Arc<ConversationObserver>,
    pub(super) plans: AcceptedPlanProducer,
    pub(super) command: Arc<crate::host::guided::command::GuidedCommand>,
    pub(super) commands: Commands,
    pub(super) tool_output: ToolOutput,
    pub(super) context_maintenance: Arc<ContextMaintenance>,
    pub(super) files: WorkspaceFiles,
    pub(super) mutations: WorkspaceMutations,
    pub(super) work_streams: Arc<super::super::WorkStreams>,
    pub(super) skills: Arc<Skills>,
}

impl HostDependencies for RuntimeOwners {
    fn close(&self) -> PortFuture<'_, ()> {
        Box::pin(async move {
            measure(
                "runtime_context_maintenance",
                self.context_maintenance.close(),
            )
            .await;
            measure("runtime_project_tools", self.project_tools.close()).await;
            measure("runtime_project_work", self.project_work.close()).await;
            measure("runtime_session_worktrees", self.session_worktrees.close()).await;
            let image_files = measure("runtime_image_files", self.image_files.close())
                .await
                .map_err(|source| {
                    BtccError::relayed("image_files_close_failed", "Image file owner did not close")
                        .with_source(source)
                });
            let attachment_context = measure(
                "runtime_attachment_context",
                self.attachment_context.close(),
            )
            .await
            .map_err(setup);
            let memory_sync = measure("runtime_memory_sync", self.memory_sync.close()).await;
            let embedding = measure("runtime_embedding", self.embedding.close())
                .await
                .map_err(setup);
            measure("runtime_profile", self.profile.close()).await;
            measure("runtime_cognition", self.cognition.close()).await;
            measure("runtime_memory_recall", self.memory_recall.close()).await;
            let conversation_tools = measure(
                "runtime_conversation_tools",
                self.conversation_tools.close(),
            )
            .await
            .map_err(setup);
            let memory_query = measure("runtime_memory_query", self.memory_query.close())
                .await
                .map_err(|e| BtccError::relayed(e.code(), e.message()));
            let conversation_reference = measure(
                "runtime_conversation_reference",
                self.conversation_reference.close(),
            )
            .await
            .map_err(|e| BtccError::relayed(e.code(), e.message()));
            measure("runtime_plans", self.plans.close()).await;
            measure("runtime_command", self.command.close()).await;
            measure("runtime_commands", self.commands.close()).await;
            measure("runtime_tool_output", self.tool_output.close()).await;
            measure("runtime_files", self.files.close()).await;
            measure("runtime_mutations", self.mutations.close()).await;
            measure("runtime_skills", self.skills.close()).await;
            let work_streams = measure("runtime_work_streams", self.work_streams.close()).await;
            let observer = measure("runtime_observer", self.observer.close())
                .await
                .map_err(BtccError::from);
            let stores = measure("runtime_stores", self.stores.close()).await;
            image_files
                .and(attachment_context)
                .and(memory_sync)
                .and(conversation_tools)
                .and(memory_query)
                .and(conversation_reference)
                .and(observer)
                .and(work_streams)
                .and(stores)
                .and(embedding)
        })
    }
}

/// Daily maintenance owns the same paths and metrics as its cognition jobs.
pub(super) fn context_maintenance(
    owners: DailyCognitionOwners,
    tool_output: ToolOutput,
) -> Arc<ContextMaintenance> {
    let root = owners.data_root.clone();
    let metrics = owners.metrics.clone();
    let timezone = owners.date_parser.clone();
    Arc::new(ContextMaintenance::new(
        root,
        tool_output,
        metrics,
        timezone,
        Arc::new(DailyCognitionJobs::new(owners)),
    ))
}

/// Exact source readers share a path authority and a bounded blocking pool.
pub(super) fn memory_source_readers(
    data_root: &std::path::Path,
    paths: &butler_memory::cognition::CognitionPathEnvironment,
) -> (Arc<ExactMemoryQuery>, Arc<ConversationSessionReference>) {
    let sources = Arc::new(crate::host::MemorySourceReader::new(
        data_root.to_owned(),
        paths.clone(),
    ));
    (
        Arc::new(ExactMemoryQuery::new(data_root, 2)),
        Arc::new(ConversationSessionReference::new(data_root, 2, sources)),
    )
}
