use super::*;

impl GatewayApplication for AppApplication {
    fn get_usage_monitor(&self, query: AppUsageMonitorQuery) -> ApplicationFuture<Value> {
        self.dependencies.monitoring.usage_monitor(query)
    }
    fn work_status(&self) -> ApplicationFuture<Vec<AppBoundWorkStatusFact>> {
        self.dependencies.monitoring.work_status()
    }
    fn work_status_conversation(
        &self,
        chat_id: String,
    ) -> ApplicationFuture<AppWorkStatusConversationFact> {
        let this = self.clone_handle();
        Box::pin(async move { this.work_status_conversation_owned(chat_id).await })
    }
    fn list_system_events(&self, page: AppMonitorPage) -> ApplicationFuture<Value> {
        self.dependencies.monitoring.system_events(page)
    }
    fn list_developer_logs(&self, query: AppDeveloperLogsQuery) -> ApplicationFuture<Value> {
        self.dependencies.monitoring.developer_logs(query)
    }
    fn check_app_update(
        &self,
        request: crate::operations::UpdateRequest,
    ) -> ApplicationFuture<serde_json::Value> {
        let updates = self.dependencies.updates.clone();
        Box::pin(async move {
            updates
                .check(request)
                .await
                .map_err(super::updates::update_error)
        })
    }
    fn apply_app_update(
        &self,
        request: crate::operations::UpdateRequest,
    ) -> ApplicationFuture<serde_json::Value> {
        let updates = self.dependencies.updates.clone();
        Box::pin(async move {
            updates
                .apply(request)
                .await
                .map_err(super::updates::update_error)
        })
    }
    fn list_skills(&self) -> ApplicationFuture<SkillSettingsView> {
        let this = self.clone_handle();
        Box::pin(async move {
            let projects = this
                .list_projects(false)
                .await?
                .projects
                .into_iter()
                .map(|project| (project.id, project.display_name))
                .collect();
            this.dependencies
                .skills
                .settings(projects)
                .await
                .map_err(skill_error)
        })
    }
    fn import_skill(
        &self,
        archive: StagedSkillArchive,
        project_id: Option<String>,
    ) -> ApplicationFuture<SkillImportResult> {
        let skills = self.dependencies.skills.clone();
        Box::pin(async move {
            skills
                .import(archive, project_id)
                .await
                .map_err(skill_error)
        })
    }
    fn create_project(
        &self,
        request: AppCreateProjectRequest,
    ) -> ApplicationFuture<AppCreateProjectResult> {
        let this = self.clone_handle();
        Box::pin(async move { this.create_project_owned(request).await })
    }
    fn list_projects(&self, include_sessions: bool) -> ApplicationFuture<AppProjectList> {
        let this = self.clone_handle();
        Box::pin(async move { this.list_projects(include_sessions).await })
    }
    fn new_chat_briefing(
        &self,
        date: Option<String>,
        project_id: Option<String>,
    ) -> ApplicationFuture<serde_json::Value> {
        let this = self.clone_handle();
        Box::pin(async move { this.new_chat_briefing_view(date, project_id).await })
    }
    fn create_session(
        &self,
        request: AppCreateSessionRequest,
        server_shutdown: tokio_util::sync::CancellationToken,
    ) -> ApplicationFuture<AppCreateSessionResult> {
        let this = self.clone_handle();
        Box::pin(async move { this.create_session_owned(request, server_shutdown).await })
    }
    fn start_topic_conversation(
        &self,
        request: AppStartTopicConversationRequest,
        server_shutdown: tokio_util::sync::CancellationToken,
    ) -> ApplicationFuture<AppSessionBranchResult> {
        let this = self.clone_handle();
        Box::pin(async move {
            this.start_topic_conversation_owned(request, server_shutdown)
                .await
        })
    }
    fn list_chats(&self) -> ApplicationFuture<Vec<AppChatSummary>> {
        let this = self.clone_handle();
        Box::pin(async move { this.list_chats().await })
    }
    fn read_navigation(&self) -> ApplicationFuture<serde_json::Value> {
        let this = self.clone_handle();
        Box::pin(async move { this.read_navigation().await })
    }
    fn search_command_palette(&self, query: String) -> ApplicationFuture<serde_json::Value> {
        let this = self.clone_handle();
        Box::pin(async move { this.search_command_palette(query).await })
    }
    fn list_archives(
        &self,
        limit: Option<usize>,
        offset: Option<usize>,
    ) -> ApplicationFuture<serde_json::Value> {
        let this = self.clone_handle();
        Box::pin(async move { this.list_archives_owned(limit, offset).await })
    }
    fn read_app_info(&self) -> ApplicationFuture<serde_json::Value> {
        let this = self.clone_handle();
        Box::pin(async move { this.app_info().await })
    }
    fn model_catalog(
        &self,
        command: AppModelCatalogCommand,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> ApplicationFuture<serde_json::Value> {
        self.dependencies
            .model_catalog
            .execute(command, cancellation)
    }
    fn personalization(
        &self,
        command: AppPersonalizationCommand,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> ApplicationFuture<serde_json::Value> {
        let this = self.clone_handle();
        Box::pin(async move { this.personalization_owned(command, cancellation).await })
    }
    fn list_sessions(
        &self,
        kind: Option<String>,
        project_id: Option<String>,
    ) -> ApplicationFuture<Vec<AppSessionSummary>> {
        let this = self.clone_handle();
        Box::pin(async move { this.list_sessions(kind, project_id).await })
    }
    fn list_automations(
        &self,
        target_session_id: Option<String>,
    ) -> ApplicationFuture<AutomationListView> {
        let this = self.clone_handle();
        Box::pin(async move { this.list_automations_owned(target_session_id).await })
    }
    fn get_automation(&self, id: String) -> ApplicationFuture<AutomationDetailView> {
        let this = self.clone_handle();
        Box::pin(async move { this.get_automation_owned(id).await })
    }
    fn create_automation(
        &self,
        request: CreateAutomationRequest,
    ) -> ApplicationFuture<AutomationMutationResult> {
        let this = self.clone_handle();
        Box::pin(async move { this.create_automation_owned(request).await })
    }
    fn update_automation(
        &self,
        id: String,
        request: UpdateAutomationRequest,
    ) -> ApplicationFuture<AutomationMutationResult> {
        let this = self.clone_handle();
        Box::pin(async move { this.update_automation_owned(id, request).await })
    }
    fn delete_automation(&self, id: String) -> ApplicationFuture<AutomationMutationResult> {
        let this = self.clone_handle();
        Box::pin(async move { this.delete_automation_owned(id).await })
    }
    fn run_automation(&self, id: String) -> ApplicationFuture<AutomationRunResult> {
        let this = self.clone_handle();
        Box::pin(async move { this.run_automation_owned(id, "run_now").await })
    }
    fn dispatch_due_automations(&self) -> ApplicationFuture<AutomationRunListView> {
        let this = self.clone_handle();
        Box::pin(async move { this.dispatch_due_owned().await })
    }
    fn list_automation_runs(&self, id: String) -> ApplicationFuture<AutomationRunListView> {
        let this = self.clone_handle();
        Box::pin(async move { this.list_automation_runs_owned(id).await })
    }
    fn upload_message_file(
        &self,
        input: AppFileUpload,
    ) -> ApplicationFuture<crate::gateway::MessageFileRef> {
        let this = self.clone_handle();
        Box::pin(async move { this.upload_message_file(input).await })
    }
    fn download_message_file(&self, id: String) -> ApplicationFuture<AppFileDownload> {
        let this = self.clone_handle();
        Box::pin(async move { this.download_message_file(id).await })
    }
    fn runtime_readiness(&self) -> Result<RuntimeReadinessView, GatewayApplicationError> {
        self.dependencies.executor_readiness.readiness()
    }
    fn read_settings(&self) -> ApplicationFuture<serde_json::Value> {
        let this = self.clone_handle();
        Box::pin(async move { this.worker_profile_settings().await })
    }
    fn update_settings(&self, input: serde_json::Value) -> ApplicationFuture<serde_json::Value> {
        let this = self.clone_handle();
        Box::pin(async move { this.update_settings_owned(input).await })
    }
    fn list_mcp_servers(&self) -> ApplicationFuture<serde_json::Value> {
        let client = self.dependencies.mcp_client.clone();
        Box::pin(async move {
            client
                .list_servers()
                .map_err(|_| GatewayApplicationError::Public {
                    status: 500,
                    code: "mcp_registry_unavailable".into(),
                    message: "MCP server registry is unavailable.".into(),
                })
        })
    }
    fn list_mcp_capabilities(
        &self,
        shutdown: tokio_util::sync::CancellationToken,
    ) -> ApplicationFuture<serde_json::Value> {
        let client = self.dependencies.mcp_client.clone();
        Box::pin(async move {
            client
                .list_capabilities(true, &shutdown)
                .await
                .map_err(|error| GatewayApplicationError::Public {
                    status: 500,
                    code: error.code.into(),
                    message: error.message.into(),
                })
        })
    }
    fn create_mcp_server(&self, input: serde_json::Value) -> ApplicationFuture<serde_json::Value> {
        let client = self.dependencies.mcp_client.clone();
        Box::pin(async move {
            client
                .upsert_server(input)
                .await
                .map(|server| serde_json::json!({"server": server}))
                .map_err(|message| GatewayApplicationError::Public {
                    status: 400,
                    code: "mcp_server_save_failed".into(),
                    message,
                })
        })
    }
    fn update_mcp_server(
        &self,
        id: String,
        input: serde_json::Value,
    ) -> ApplicationFuture<serde_json::Value> {
        let client = self.dependencies.mcp_client.clone();
        Box::pin(async move {
            client
                .update_server(id, input)
                .await
                .map(|server| serde_json::json!({"server": server}))
                .map_err(|message| GatewayApplicationError::Public {
                    status: if message.contains("not found") {
                        404
                    } else {
                        400
                    },
                    code: "mcp_server_update_failed".into(),
                    message,
                })
        })
    }
    fn delete_mcp_server(&self, id: String) -> ApplicationFuture<serde_json::Value> {
        let client = self.dependencies.mcp_client.clone();
        Box::pin(async move {
            client
                .delete_server(id)
                .await
                .map_err(|_| GatewayApplicationError::Internal)
        })
    }
    fn probe_mcp_server(
        &self,
        id: String,
        shutdown: tokio_util::sync::CancellationToken,
    ) -> ApplicationFuture<serde_json::Value> {
        let client = self.dependencies.mcp_client.clone();
        Box::pin(async move {
            client
                .probe_server(&id, &shutdown)
                .await
                .map(|server| serde_json::json!({"servers": [server]}))
                .map_err(|error| GatewayApplicationError::Public {
                    status: if error.code == "mcp_server_not_found" {
                        404
                    } else {
                        500
                    },
                    code: error.code.into(),
                    message: error.message.into(),
                })
        })
    }
    fn send_message(&self, command: SendMessageCommand) -> ApplicationFuture<MessageSendResult> {
        let this = self.clone_handle();
        Box::pin(async move { this.send(command).await })
    }
    fn authority_list(&self, owner_session_id: String) -> ApplicationFuture<AppAuthorityPage> {
        self.dependencies.authority_handoff.list(owner_session_id)
    }
    fn authority_revoke(
        &self,
        owner_session_id: String,
        grant_ref: String,
    ) -> ApplicationFuture<()> {
        self.dependencies
            .authority_handoff
            .revoke(owner_session_id, grant_ref)
    }
    fn authority_decide(
        &self,
        input: AppAuthorityDecisionInput,
    ) -> ApplicationFuture<AppAuthorityDecision> {
        self.dependencies.authority_handoff.decide(input)
    }
    fn refresh_message_projection(&self, chat_id: String) -> ApplicationFuture<()> {
        let owner = self.projection.clone();
        Box::pin(async move { owner.refresh(chat_id).await })
    }
    fn list_messages(
        &self,
        chat_id: String,
        after: f64,
        limit: usize,
    ) -> ApplicationFuture<crate::gateway::MessageListView> {
        let this = self.clone_handle();
        Box::pin(async move { this.message_page(chat_id, after, limit).await })
    }
    fn list_artifacts(
        &self,
        session_id: String,
    ) -> ApplicationFuture<Vec<crate::gateway::SessionArtifactSummary>> {
        let this = self.clone_handle();
        Box::pin(async move { this.artifact_page(session_id).await })
    }
    fn export_transcript(&self, session_id: String) -> ApplicationFuture<TranscriptExport> {
        let this = self.clone_handle();
        Box::pin(async move { this.export_transcript_owned(session_id).await })
    }
    fn list_session_queue(&self, session_id: String) -> ApplicationFuture<SessionQueueView> {
        let this = self.clone_handle();
        Box::pin(async move { this.queue_page(session_id).await })
    }
    fn create_session_queue(
        &self,
        request: crate::gateway::MessageSendRequest,
    ) -> ApplicationFuture<SessionQueueView> {
        let this = self.clone_handle();
        Box::pin(async move { this.create_session_queue_owned(request).await })
    }
    fn update_session_queue(
        &self,
        queued_message_id: String,
        request: SessionQueueUpdateRequest,
    ) -> ApplicationFuture<SessionQueueView> {
        let this = self.clone_handle();
        Box::pin(async move {
            this.update_session_queue_owned(queued_message_id, request)
                .await
        })
    }
    fn delete_session_queue(
        &self,
        queued_message_id: String,
    ) -> ApplicationFuture<SessionQueueView> {
        let this = self.clone_handle();
        Box::pin(async move { this.delete_session_queue_owned(queued_message_id).await })
    }
    fn list_turns(
        &self,
        chat_id: String,
        after: f64,
    ) -> ApplicationFuture<crate::gateway::TurnListView> {
        let this = self.clone_handle();
        Box::pin(async move { this.turn_page(chat_id, after).await })
    }
    fn get_operation_output(
        &self,
        turn_id: String,
        request_id: String,
        result_id: String,
        byte_start: u64,
    ) -> ApplicationFuture<Option<OperationOutputView>> {
        let this = self.clone_handle();
        Box::pin(async move {
            this.get_operation_output_owned(turn_id, request_id, result_id, byte_start)
                .await
        })
    }
    fn cancel_turn(&self, turn_id: String) -> ApplicationFuture<Value> {
        let this = self.clone_handle();
        Box::pin(async move { this.cancel_turn_owned(turn_id).await })
    }
    fn retry_turn(&self, turn_id: String) -> ApplicationFuture<Value> {
        let this = self.clone_handle();
        Box::pin(async move { this.retry_turn_owned(turn_id).await })
    }
    fn retry_turn_with_current_controls(
        &self,
        turn_id: String,
    ) -> ApplicationFuture<MessageSendResult> {
        let this = self.clone_handle();
        Box::pin(async move { this.retry_turn_with_current_controls_owned(turn_id).await })
    }
    fn subsession_projection(&self, session_id: String) -> ApplicationFuture<Value> {
        self.dependencies.subsessions.projection(session_id, None)
    }
    fn session_view(
        &self,
        session_id: String,
        page: AppSessionViewPage,
    ) -> ApplicationFuture<Value> {
        let this = self.clone_handle();
        Box::pin(async move { this.session_view_owned(session_id, page).await })
    }
    fn session_summary_view(&self, session_id: String) -> ApplicationFuture<Value> {
        let this = self.clone_handle();
        Box::pin(async move { this.session_summary_owned(session_id).await })
    }
    fn context_details(&self, session_id: String) -> ApplicationFuture<Value> {
        let this = self.clone_handle();
        Box::pin(async move { this.context_details_owned(session_id).await })
    }
    fn cancel_subsession(
        &self,
        parent_session_id: String,
        relation_id: String,
    ) -> ApplicationFuture<Value> {
        self.dependencies
            .subsessions
            .cancel(parent_session_id, relation_id)
    }
    fn resume_subsession(
        &self,
        parent_session_id: String,
        relation_id: String,
    ) -> ApplicationFuture<Value> {
        self.dependencies
            .subsessions
            .resume(parent_session_id, relation_id)
    }
    fn latest_event_cursor(&self) -> ApplicationFuture<u64> {
        let storage = self.storage.clone();
        Box::pin(async move {
            storage
                .execute(|connection| events::latest(connection))
                .await
                .map_err(app_error)
        })
    }
    fn replay_events(&self, after: f64, limit: usize) -> ApplicationFuture<Vec<AppEventEnvelope>> {
        let storage = self.storage.clone();
        Box::pin(async move {
            storage
                .execute(move |db| events::replay(db, after, limit))
                .await
                .map_err(app_error)
        })
    }
    fn subscribe_events(
        &self,
        listener: Arc<dyn Fn(AppEventEnvelope) + Send + Sync>,
    ) -> Result<Box<dyn EventSubscription>, GatewayApplicationError> {
        Ok(self.subscribers.subscribe(listener))
    }
}
