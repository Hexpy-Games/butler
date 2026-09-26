use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

use serde_json::{Map, Value, json};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};

use super::*;

mod dashboard;
mod http;
mod session_controls;
pub(super) use http::authorized_json;

pub(super) async fn start(
    application: Arc<TestApplication>,
    auth: LocalAuthConfig,
) -> GatewayServer {
    start_with_config(
        application,
        GatewayConfig {
            local_auth: auth,
            ..GatewayConfig::default()
        },
    )
    .await
}

pub(super) async fn start_with_config(
    application: Arc<TestApplication>,
    config: GatewayConfig,
) -> GatewayServer {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    serve_gateway(listener, application, config).await.unwrap()
}

pub(super) async fn request(address: std::net::SocketAddr, request: &str) -> String {
    let mut stream = TcpStream::connect(address).await.unwrap();
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut response = Vec::new();
    stream.read_to_end(&mut response).await.unwrap();
    String::from_utf8(response).unwrap()
}

type EventListener = Arc<dyn Fn(AppEventEnvelope) + Send + Sync>;
type Subscribers = Arc<Mutex<Vec<(u64, EventListener)>>>;

#[derive(Default)]
pub(super) struct TestApplication {
    pub(super) briefing: Mutex<Option<Value>>,
    pub(super) last_message: Mutex<Option<SendMessageCommand>>,
    pub(super) refreshes: Mutex<Vec<String>>,
    pub(super) message_cursor: Mutex<Option<f64>>,
    pub(super) event_cursor: Mutex<Option<f64>>,
    pub(super) event_limit: Mutex<Option<usize>>,
    pub(super) subscribers: Subscribers,
    pub(super) next_subscriber: std::sync::atomic::AtomicU64,
    pub(super) flood_on_subscribe: std::sync::atomic::AtomicBool,
}

impl TestApplication {
    pub(super) fn subscription_count(&self) -> usize {
        self.subscribers.lock().unwrap().len()
    }
}

impl GatewayMutationCommands for TestApplication {
    fn relocate_session(
        &self,
        _: AppRelocateSessionRequest,
    ) -> ApplicationFuture<AppSpaceMutationResult> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn update_project(
        &self,
        _: String,
        _: AppProjectUpdate,
    ) -> ApplicationFuture<AppProjectActionResult> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn archive_project(&self, _: String) -> ApplicationFuture<AppProjectActionResult> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn pin_project(&self, _: String, _: Option<bool>) -> ApplicationFuture<AppProjectActionResult> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn delete_project(&self, _: String, _: bool) -> ApplicationFuture<AppProjectActionResult> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn update_session(
        &self,
        _: String,
        _: AppSessionUpdate,
    ) -> ApplicationFuture<AppSessionActionResult> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn archive_session(
        &self,
        _: String,
        _: Option<String>,
    ) -> ApplicationFuture<AppSessionActionResult> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn delete_session(&self, _: String, _: bool) -> ApplicationFuture<AppSessionActionResult> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn mutate_space(
        &self,
        _: AppSpaceCommand,
        _: AppSpaceOrigin,
        _: Option<String>,
    ) -> ApplicationFuture<AppSpaceMutationResult> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
}

impl GatewayApplication for TestApplication {
    fn get_operation_output(
        &self,
        _: String,
        _: String,
        _: String,
        _: u64,
    ) -> ApplicationFuture<Option<OperationOutputView>> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn retry_turn(&self, _: String) -> ApplicationFuture<Value> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn retry_turn_with_current_controls(&self, _: String) -> ApplicationFuture<MessageSendResult> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn get_usage_monitor(&self, _: AppUsageMonitorQuery) -> ApplicationFuture<Value> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn work_status(&self) -> ApplicationFuture<Vec<AppBoundWorkStatusFact>> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn work_status_conversation(
        &self,
        _: String,
    ) -> ApplicationFuture<AppWorkStatusConversationFact> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn list_system_events(&self, _: AppMonitorPage) -> ApplicationFuture<Value> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn list_developer_logs(&self, _: AppDeveloperLogsQuery) -> ApplicationFuture<Value> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn check_app_update(
        &self,
        _request: crate::operations::UpdateRequest,
    ) -> ApplicationFuture<serde_json::Value> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn apply_app_update(
        &self,
        _request: crate::operations::UpdateRequest,
    ) -> ApplicationFuture<serde_json::Value> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn create_project(
        &self,
        _: AppCreateProjectRequest,
    ) -> ApplicationFuture<AppCreateProjectResult> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn list_projects(&self, _: bool) -> ApplicationFuture<AppProjectList> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn new_chat_briefing(&self, _: Option<String>, _: Option<String>) -> ApplicationFuture<Value> {
        let view = self.briefing.lock().unwrap().clone();
        Box::pin(async move { view.ok_or(GatewayApplicationError::Internal) })
    }
    fn create_session(
        &self,
        _: AppCreateSessionRequest,
        _: tokio_util::sync::CancellationToken,
    ) -> ApplicationFuture<AppCreateSessionResult> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn list_chats(&self) -> ApplicationFuture<Vec<AppChatSummary>> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn read_navigation(&self) -> ApplicationFuture<Value> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn search_command_palette(&self, _: String) -> ApplicationFuture<Value> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn list_archives(&self, _: Option<usize>, _: Option<usize>) -> ApplicationFuture<Value> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn read_app_info(&self) -> ApplicationFuture<Value> {
        Box::pin(async { Ok(json!({"name":"Butler","version":"1.0.0"})) })
    }
    fn model_catalog(
        &self,
        _: AppModelCatalogCommand,
        _: tokio_util::sync::CancellationToken,
    ) -> ApplicationFuture<Value> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn personalization(
        &self,
        _: AppPersonalizationCommand,
        _: tokio_util::sync::CancellationToken,
    ) -> ApplicationFuture<Value> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn list_sessions(
        &self,
        _: Option<String>,
        _: Option<String>,
    ) -> ApplicationFuture<Vec<AppSessionSummary>> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn list_automations(&self, _: Option<String>) -> ApplicationFuture<AutomationListView> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn get_automation(&self, _: String) -> ApplicationFuture<AutomationDetailView> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn create_automation(
        &self,
        _: CreateAutomationRequest,
    ) -> ApplicationFuture<AutomationMutationResult> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn update_automation(
        &self,
        _: String,
        _: UpdateAutomationRequest,
    ) -> ApplicationFuture<AutomationMutationResult> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn delete_automation(&self, _: String) -> ApplicationFuture<AutomationMutationResult> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn run_automation(&self, _: String) -> ApplicationFuture<AutomationRunResult> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn dispatch_due_automations(&self) -> ApplicationFuture<AutomationRunListView> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn list_automation_runs(&self, _: String) -> ApplicationFuture<AutomationRunListView> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn upload_message_file(&self, _: AppFileUpload) -> ApplicationFuture<MessageFileRef> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }

    fn download_message_file(&self, _: String) -> ApplicationFuture<AppFileDownload> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }

    fn runtime_readiness(&self) -> Result<RuntimeReadinessView, GatewayApplicationError> {
        Ok(RuntimeReadinessView {
            authenticated_gateway_ready: false,
            btcc_executor_ready: true,
            executor_pid: None,
            executor_ready_at: None,
            raw_text_included: true,
        })
    }

    fn read_settings(&self) -> ApplicationFuture<Value> {
        Box::pin(async { Ok(json!({"worker_profiles":[]})) })
    }

    fn send_message(&self, command: SendMessageCommand) -> ApplicationFuture<MessageSendResult> {
        *self.last_message.lock().unwrap() = Some(command);
        Box::pin(async { Ok(message_result()) })
    }

    fn authority_list(&self, _: String) -> ApplicationFuture<AppAuthorityPage> {
        Box::pin(async {
            Ok(AppAuthorityPage {
                requests: vec![],
                permissions: vec![],
            })
        })
    }

    fn authority_revoke(&self, _: String, _: String) -> ApplicationFuture<()> {
        Box::pin(async { Ok(()) })
    }

    fn authority_decide(
        &self,
        input: AppAuthorityDecisionInput,
    ) -> ApplicationFuture<AppAuthorityDecision> {
        Box::pin(async move {
            Ok(AppAuthorityDecision {
                request_ref: input.request_ref,
                decision: "allowed".into(),
                admitted: true,
            })
        })
    }

    fn refresh_message_projection(&self, chat_id: String) -> ApplicationFuture<()> {
        self.refreshes.lock().unwrap().push(chat_id);
        Box::pin(async { Ok(()) })
    }

    fn list_messages(
        &self,
        chat_id: String,
        after_cursor: f64,
        _limit: usize,
    ) -> ApplicationFuture<MessageListView> {
        *self.message_cursor.lock().unwrap() = Some(after_cursor);
        Box::pin(async move {
            Ok(MessageListView {
                chat_id,
                messages: vec![],
                turn_progress: Some(BTreeMap::new()),
                next_cursor: after_cursor,
            })
        })
    }

    fn list_artifacts(
        &self,
        _session_id: String,
    ) -> ApplicationFuture<Vec<SessionArtifactSummary>> {
        Box::pin(async { Ok(Vec::new()) })
    }
    fn export_transcript(&self, session_id: String) -> ApplicationFuture<TranscriptExport> {
        super::transcript_export::empty_export(session_id)
    }
    fn list_session_queue(&self, session_id: String) -> ApplicationFuture<SessionQueueView> {
        Box::pin(async move {
            Ok(SessionQueueView {
                session_id,
                queued_messages: Vec::new(),
            })
        })
    }
    fn create_session_queue(
        &self,
        _request: MessageSendRequest,
    ) -> ApplicationFuture<SessionQueueView> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn update_session_queue(
        &self,
        _queued_message_id: String,
        _request: SessionQueueUpdateRequest,
    ) -> ApplicationFuture<SessionQueueView> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn delete_session_queue(
        &self,
        _queued_message_id: String,
    ) -> ApplicationFuture<SessionQueueView> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn list_turns(&self, chat_id: String, after_cursor: f64) -> ApplicationFuture<TurnListView> {
        Box::pin(async move {
            Ok(TurnListView {
                chat_id,
                turns: vec![],
                next_cursor: after_cursor,
            })
        })
    }

    fn latest_event_cursor(&self) -> ApplicationFuture<u64> {
        let cursor = if self
            .flood_on_subscribe
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            201
        } else {
            1
        };
        Box::pin(async move { Ok(cursor) })
    }

    fn replay_events(
        &self,
        after_cursor: f64,
        limit: usize,
    ) -> ApplicationFuture<Vec<AppEventEnvelope>> {
        *self.event_cursor.lock().unwrap() = Some(after_cursor);
        *self.event_limit.lock().unwrap() = Some(limit);
        Box::pin(async { Ok(vec![event(1)]) })
    }

    fn subscribe_events(
        &self,
        listener: Arc<dyn Fn(AppEventEnvelope) + Send + Sync>,
    ) -> Result<Box<dyn EventSubscription>, GatewayApplicationError> {
        let id = self
            .next_subscriber
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.subscribers
            .lock()
            .unwrap()
            .push((id, listener.clone()));
        if self
            .flood_on_subscribe
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            for event_id in 1..=201 {
                listener(event(event_id));
            }
        }
        Ok(Box::new(TestSubscription {
            id,
            subscribers: self.subscribers.clone(),
        }))
    }
}

struct TestSubscription {
    id: u64,
    pub(super) subscribers: Subscribers,
}

impl EventSubscription for TestSubscription {}

impl Drop for TestSubscription {
    fn drop(&mut self) {
        self.subscribers
            .lock()
            .unwrap()
            .retain(|(id, _)| *id != self.id);
    }
}

fn event(id: u64) -> AppEventEnvelope {
    AppEventEnvelope {
        protocol_version: "butler.app.v1".into(),
        id,
        event_type: "message.created".into(),
        created_at: "2026-09-14T00:00:00.000Z".into(),
        payload: Map::new(),
    }
}

fn message_result() -> MessageSendResult {
    MessageSendResult {
        accepted: Some(MessageRecord {
            content_parts: None,
            id: "message-1".into(),
            chat_id: "general".into(),
            turn_id: Some("turn-1".into()),
            conversation_session_id: None,
            conversation_turn_id: None,
            conversation_message_id: None,
            role: MessageRole::User,
            text: "hello".into(),
            status: MessageStatus::Sent,
            created_at: "2026-09-14T00:00:00.000Z".into(),
            updated_at: "2026-09-14T00:00:00.000Z".into(),
            safe_error_code: None,
            delivery_state: None,
            limitation_codes: None,
            limitations: None,
            retryable: false,
            cursor: 1,
            attachments: None,
            artifacts: None,
            changed_files: None,
            plan_document: None,
            work_blocks: None,
            turn_activity_rows: None,
        }),
        queued: None,
        reply: None,
        replies: vec![],
        turn: Some(TurnRecord {
            id: "turn-1".into(),
            chat_id: "general".into(),
            user_message_id: Some("message-1".into()),
            state: TurnState::Thinking,
            safe_status_label: "Thinking".into(),
            safe_error_code: None,
            retryable: false,
            cancellable: true,
            attempt: 1,
            created_at: "2026-09-14T00:00:00.000Z".into(),
            updated_at: "2026-09-14T00:00:00.000Z".into(),
            cursor: 1,
            execution_controls: None,
            execution_model: None,
        }),
        next_cursor: 1,
    }
}
