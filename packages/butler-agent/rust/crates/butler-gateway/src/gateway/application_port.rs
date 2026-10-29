//! Application operations consumed by authenticated HTTP adapters.
use super::*;

pub trait GatewayApplication:
    GatewayMutationCommands
    + project_folder::GatewayProjectFolders
    + GatewayPendingAsks
    + GatewayProjectDashboard
    + GatewaySessionControls
    + GatewayDevices
    + GatewayWallpapers
    + GatewaySignIns
    + Send
    + Sync
    + 'static
{
    fn browser_still(
        &self,
        command: AppBrowserStillCommand,
    ) -> ApplicationFuture<serde_json::Value> {
        let _ = command;
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn data_reset(&self) -> Option<Arc<dyn AppDataResetPort>> {
        None
    }
    fn accept_full_reset(&self, _input: serde_json::Value) -> ApplicationFuture<serde_json::Value> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    /// Read a bounded page of saved browser items.
    fn library(&self, command: AppLibraryCommand) -> ApplicationFuture<serde_json::Value> {
        let _ = command;
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn runtime_session_hint(&self, chat: String) -> ApplicationFuture<String> {
        Box::pin(async move { Ok(app_session_hint(&chat)) })
    }
    fn check_app_update(
        &self,
        request: butler_runtime::operations::UpdateRequest,
    ) -> ApplicationFuture<serde_json::Value>;
    /// The last saved update status, without a network check.
    fn app_update_status(&self) -> ApplicationFuture<serde_json::Value> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn apply_app_update(
        &self,
        request: butler_runtime::operations::UpdateRequest,
    ) -> ApplicationFuture<serde_json::Value>;
    fn report_app_update_progress(&self, _stage: String) -> ApplicationFuture<serde_json::Value> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn cancel_app_update(&self) -> ApplicationFuture<serde_json::Value> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn list_skills(&self) -> ApplicationFuture<butler_runtime::skills::SkillSettingsView> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn import_skill(
        &self,
        _archive: butler_runtime::skills::StagedSkillArchive,
        _project_id: Option<String>,
    ) -> ApplicationFuture<butler_runtime::skills::SkillImportResult> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn create_project(
        &self,
        request: AppCreateProjectRequest,
    ) -> ApplicationFuture<AppCreateProjectResult>;
    fn list_projects(&self, include_sessions: bool) -> ApplicationFuture<AppProjectList>;
    fn new_chat_briefing(
        &self,
        date: Option<String>,
        project_id: Option<String>,
    ) -> ApplicationFuture<serde_json::Value>;
    fn create_session(
        &self,
        request: AppCreateSessionRequest,
        server_shutdown: CancellationToken,
    ) -> ApplicationFuture<AppCreateSessionResult>;
    fn start_topic_conversation(
        &self,
        _request: AppStartTopicConversationRequest,
        _server_shutdown: CancellationToken,
    ) -> ApplicationFuture<AppSessionBranchResult> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    /// Where a branch conversation's source answer is shown now.
    fn branch_source(&self, _session_id: String) -> ApplicationFuture<AppBranchSourceLocation> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn list_chats(&self, page: Option<(u32, u32)>) -> ApplicationFuture<Vec<AppChatSummary>>;
    fn read_navigation(&self) -> ApplicationFuture<serde_json::Value>;
    fn read_user_work(&self) -> ApplicationFuture<serde_json::Value> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn search_command_palette(&self, query: String) -> ApplicationFuture<serde_json::Value>;
    fn list_archives(
        &self,
        limit: Option<usize>,
        offset: Option<usize>,
    ) -> ApplicationFuture<serde_json::Value>;
    fn get_usage_history(&self) -> ApplicationFuture<serde_json::Value> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn get_usage_monitor(
        &self,
        query: AppUsageMonitorQuery,
    ) -> ApplicationFuture<serde_json::Value>;
    /// `GET /provider-quota`: the latest quota, polled first on `refresh`.
    fn get_provider_quota(&self, id: String, refresh: bool)
    -> ApplicationFuture<ProviderQuotaView>;
    fn worker_activity_page(
        &self,
        _query: AppWorkerActivityQuery,
    ) -> ApplicationFuture<Option<serde_json::Value>> {
        Box::pin(async { Ok(None) })
    }
    fn work_status(&self) -> ApplicationFuture<Vec<AppBoundWorkStatusFact>>;
    fn work_status_conversation(
        &self,
        chat_id: String,
    ) -> ApplicationFuture<AppWorkStatusConversationFact>;
    fn list_system_events(&self, page: AppMonitorPage) -> ApplicationFuture<serde_json::Value>;
    fn read_app_info(&self) -> ApplicationFuture<serde_json::Value>;
    fn model_catalog(
        &self,
        command: AppModelCatalogCommand,
        cancellation: CancellationToken,
    ) -> ApplicationFuture<serde_json::Value>;
    fn memory_management(
        &self,
        _command: AppMemoryCommand,
        _cancellation: CancellationToken,
    ) -> ApplicationFuture<serde_json::Value> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn personalization(
        &self,
        command: AppPersonalizationCommand,
        cancellation: CancellationToken,
    ) -> ApplicationFuture<serde_json::Value>;
    fn list_sessions(
        &self,
        kind: Option<String>,
        project_id: Option<String>,
        page: Option<(u32, u32)>,
    ) -> ApplicationFuture<Vec<AppSessionSummary>>;
    fn list_automations(
        &self,
        target_session_id: Option<String>,
        include_deleted: bool,
    ) -> ApplicationFuture<AutomationListView>;
    fn get_automation(&self, id: String) -> ApplicationFuture<AutomationDetailView>;
    fn create_automation(
        &self,
        request: CreateAutomationRequest,
    ) -> ApplicationFuture<AutomationMutationResult>;
    fn update_automation(
        &self,
        id: String,
        request: UpdateAutomationRequest,
    ) -> ApplicationFuture<AutomationMutationResult>;
    fn delete_automation(&self, id: String) -> ApplicationFuture<AutomationMutationResult>;
    fn run_automation(&self, id: String) -> ApplicationFuture<AutomationRunResult>;
    fn dispatch_due_automations(&self) -> ApplicationFuture<AutomationRunListView>;
    fn list_automation_runs(&self, id: String) -> ApplicationFuture<AutomationRunListView>;
    fn image_usage(
        &self,
        _command: super::AppImageUsageCommand,
    ) -> ApplicationFuture<serde_json::Value> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn assets(&self, _command: AppAssetCommand) -> ApplicationFuture<serde_json::Value> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn upload_message_file(&self, input: AppFileUpload) -> ApplicationFuture<MessageFileRef>;
    fn message_file_metadata(&self, id: String) -> ApplicationFuture<MessageFileRef>;
    fn download_message_file(&self, id: String) -> ApplicationFuture<AppFileDownload>;
    fn runtime_readiness(&self) -> Result<RuntimeReadinessView, GatewayApplicationError>;
    /// First-run setup (#230); an application without it answers 404.
    fn setup(&self) -> Result<Arc<dyn AppSetupPort>, GatewayApplicationError> {
        Err(GatewayApplicationError::public(
            404,
            "not_found",
            "Route not found.",
        ))
    }
    fn read_settings(&self) -> ApplicationFuture<serde_json::Value>;
    fn update_settings(&self, input: serde_json::Value) -> ApplicationFuture<serde_json::Value> {
        let _ = input;
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    /// User lifecycle hook service; absent without a host implementation.
    /// Host-owned plugin administration; never a model tool.
    fn plugins(&self) -> Option<std::sync::Arc<dyn butler_core::plugins::PluginPort>> {
        None
    }
    fn hooks(&self) -> Option<std::sync::Arc<dyn butler_core::hooks::HookPort>> {
        None
    }
    fn list_mcp_servers(&self) -> ApplicationFuture<serde_json::Value> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn list_mcp_capabilities(
        &self,
        _shutdown: CancellationToken,
    ) -> ApplicationFuture<serde_json::Value> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn create_mcp_server(&self, _input: serde_json::Value) -> ApplicationFuture<serde_json::Value> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn update_mcp_server(
        &self,
        _id: String,
        _input: serde_json::Value,
    ) -> ApplicationFuture<serde_json::Value> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn delete_mcp_server(&self, _id: String) -> ApplicationFuture<serde_json::Value> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn probe_mcp_server(
        &self,
        _id: String,
        _shutdown: CancellationToken,
    ) -> ApplicationFuture<serde_json::Value> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn send_message(&self, command: SendMessageCommand) -> ApplicationFuture<MessageSendResult>;
    fn authority_permissions(&self) -> ApplicationFuture<Vec<AppGrantView>>;
    fn authority_revoke_permissions(&self, grants: Vec<AppGrantRef>) -> ApplicationFuture<()>;
    fn authority_list(&self, owner_session_id: String) -> ApplicationFuture<AppAuthorityPage>;
    fn authority_revoke(
        &self,
        owner_session_id: String,
        grant_ref: String,
    ) -> ApplicationFuture<()>;
    fn authority_decide(
        &self,
        input: AppAuthorityDecisionInput,
    ) -> ApplicationFuture<AppAuthorityDecision>;
    fn refresh_message_projection(&self, chat_id: String) -> ApplicationFuture<()>;
    fn list_messages(
        &self,
        chat_id: String,
        after_cursor: f64,
        limit: usize,
    ) -> ApplicationFuture<MessageListView>;
    fn list_artifacts(&self, session_id: String) -> ApplicationFuture<Vec<SessionArtifactSummary>>;
    fn export_transcript(&self, session_id: String) -> ApplicationFuture<TranscriptExport>;
    fn list_session_queue(&self, session_id: String) -> ApplicationFuture<SessionQueueView>;
    fn create_session_queue(
        &self,
        request: MessageSendRequest,
    ) -> ApplicationFuture<SessionQueueView>;
    fn update_session_queue(
        &self,
        queued_message_id: String,
        request: SessionQueueUpdateRequest,
    ) -> ApplicationFuture<SessionQueueView>;
    fn send_session_queue_now(
        &self,
        queued_message_id: String,
    ) -> ApplicationFuture<SessionQueueView>;
    fn delete_session_queue(
        &self,
        queued_message_id: String,
    ) -> ApplicationFuture<SessionQueueView>;
    fn list_turns(&self, chat_id: String, after_cursor: f64) -> ApplicationFuture<TurnListView>;
    fn get_operation_output(
        &self,
        turn_id: String,
        request_id: String,
        result_id: String,
        byte_start: u64,
    ) -> ApplicationFuture<Option<OperationOutputView>>;
    fn cancel_turn(&self, _turn_id: String) -> ApplicationFuture<serde_json::Value> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn retry_turn(&self, turn_id: String) -> ApplicationFuture<serde_json::Value>;
    fn retry_turn_with_current_controls(
        &self,
        turn_id: String,
    ) -> ApplicationFuture<MessageSendResult>;
    fn canon_proposal(
        &self,
        _action: String,
        _input: serde_json::Value,
    ) -> ApplicationFuture<serde_json::Value> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn canon(&self, _request: AppCanonRequest) -> ApplicationFuture<serde_json::Value> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn task_graph_read(&self, _query: AppTaskGraphQuery) -> ApplicationFuture<serde_json::Value> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn subsession_projection(&self, _session_id: String) -> ApplicationFuture<serde_json::Value> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn session_view(
        &self,
        _session_id: String,
        _page: AppSessionViewPage,
    ) -> ApplicationFuture<serde_json::Value> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn session_summary_view(&self, _session_id: String) -> ApplicationFuture<serde_json::Value> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn context_details(&self, _session_id: String) -> ApplicationFuture<serde_json::Value> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn cancel_subsession(
        &self,
        _parent_session_id: String,
        _relation_id: String,
    ) -> ApplicationFuture<serde_json::Value> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn resume_subsession(
        &self,
        _parent_session_id: String,
        _relation_id: String,
    ) -> ApplicationFuture<serde_json::Value> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    /// Records and publishes a live event the gateway itself raises, such as
    /// `security.connection_code_rotated`. Without an event log, a no-op.
    fn publish_gateway_event(
        &self,
        _event_type: &'static str,
        _payload: serde_json::Map<String, serde_json::Value>,
    ) -> ApplicationFuture<()> {
        Box::pin(async { Ok(()) })
    }
    fn latest_event_cursor(&self) -> ApplicationFuture<u64>;
    fn replay_events(
        &self,
        after_cursor: f64,
        limit: usize,
    ) -> ApplicationFuture<Vec<AppEventEnvelope>>;
    fn subscribe_events(
        &self,
        listener: Arc<dyn Fn(Arc<PublishedEvent>) + Send + Sync>,
    ) -> Result<Box<dyn EventSubscription>, GatewayApplicationError>;
}
