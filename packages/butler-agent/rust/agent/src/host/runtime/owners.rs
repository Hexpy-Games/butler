//! Runtime owner shutdown after admission has stopped and Turn futures have drained.

use super::*;
use crate::skills::NativeSkills;

pub(super) struct RuntimeOwners {
    pub(super) stores: RuntimeStores,
    pub(super) project_work: Arc<NativeProjectWork>,
    pub(super) project_tools: Arc<super::super::guided_project_tools::NativeGuidedProjectTools>,
    pub(super) session_worktrees: NativeSessionWorktrees,
    pub(super) image_files: Arc<crate::gateway::NativeAppImageFiles>,
    pub(super) attachment_context: Arc<crate::context::NativeAttachmentContext>,
    pub(super) memory_sync: super::super::memory_sync::NativeMemorySync,
    #[cfg(unix)]
    pub(super) embedding: Arc<super::super::NativeEmbeddingOwner>,
    pub(super) profile: Arc<ProfileService>,
    pub(super) cognition: Arc<NativeCognitionPromptReader>,
    pub(super) memory_query: Arc<NativeExactMemoryQuery>,
    pub(super) memory_recall: Arc<NativeMemoryRecall>,
    pub(super) conversation_reference: Arc<NativeConversationSessionReference>,
    pub(super) conversation_tools: Arc<NativeConversationTools>,
    pub(super) observer: Arc<NativeConversationObserver>,
    pub(super) plans: NativeAcceptedPlanProducer,
    pub(super) command: Arc<super::super::guided_command::NativeGuidedCommand>,
    pub(super) commands: NativeCommands,
    pub(super) tool_output: NativeToolOutput,
    pub(super) context_maintenance: Arc<ContextMaintenance>,
    pub(super) files: NativeWorkspaceFiles,
    pub(super) mutations: WorkspaceMutations,
    pub(super) work_streams: Arc<super::super::NativeWorkStreams>,
    pub(super) skills: Arc<NativeSkills>,
    pub(super) automations: Arc<crate::operations::NativeAutomationService>,
}

impl HostDependencies for RuntimeOwners {
    fn close(&self) -> PortFuture<'_, ()> {
        Box::pin(async move {
            self.context_maintenance.close().await;
            let automations = self
                .automations
                .close()
                .await
                .map_err(|error| BtccError::new(error.code, error.message));
            self.project_tools.close().await;
            self.project_work.close().await;
            self.session_worktrees.close().await;
            let image_files = self.image_files.close().await.map_err(|_| {
                BtccError::new("image_files_close_failed", "Image file owner did not close")
            });
            let attachment_context = self.attachment_context.close().await.map_err(setup);
            let memory_sync = self.memory_sync.close().await;
            #[cfg(unix)]
            let embedding = self.embedding.close().await.map_err(setup);
            self.profile.close().await;
            self.cognition.close().await;
            self.memory_recall.close().await;
            let conversation_tools = self.conversation_tools.close().await.map_err(setup);
            let memory_query = self
                .memory_query
                .close()
                .await
                .map_err(|e| BtccError::new(e.code, e.message));
            let conversation_reference = self
                .conversation_reference
                .close()
                .await
                .map_err(|e| BtccError::new(e.code, e.message));
            self.plans.close().await;
            self.command.close().await;
            self.commands.close().await;
            self.tool_output.close().await;
            self.files.close().await;
            self.mutations.close().await;
            self.skills.close().await;
            let work_streams = self.work_streams.close().await;
            let observer = self
                .observer
                .close()
                .await
                .map_err(|e| BtccError::new(e.code, e.message));
            let stores = self.stores.close().await;
            let result = image_files
                .and(attachment_context)
                .and(memory_sync)
                .and(conversation_tools)
                .and(memory_query)
                .and(conversation_reference)
                .and(observer)
                .and(automations)
                .and(work_streams)
                .and(stores);
            #[cfg(unix)]
            let result = result.and(embedding);
            result
        })
    }
}
