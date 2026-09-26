use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

use serde_json::{Value, json};

use super::super::*;
use crate::btcc::ReasoningEffort;
use crate::gateway::MessageSendRequest;

mod relocation;
pub(super) use relocation::UnprovidedRelocation;

pub(super) struct Clock(pub(super) AtomicU64);
pub(super) struct RuntimeInfo;

impl AppRuntimeInfoProvider for RuntimeInfo {
    fn app_version(&self) -> Result<String, GatewayApplicationError> {
        Ok("1.0.0".into())
    }
}

impl AppIdentityClock for Clock {
    fn new_uuid(&self) -> String {
        let n = self.0.fetch_add(1, Ordering::Relaxed);
        format!("00000000-0000-4000-8000-{n:012x}")
    }
    fn now_iso(&self) -> String {
        "2026-09-14T00:00:00.000Z".into()
    }
    fn iso_after_millis(&self, _: u64) -> String {
        "2026-09-14T00:01:00.000Z".into()
    }
}

pub(super) struct Admission;
pub(super) struct UnprovidedSessions;

pub(super) struct ModelCatalog;

impl AppModelCatalogPort for ModelCatalog {
    fn execute(
        &self,
        _: AppModelCatalogCommand,
        _: tokio_util::sync::CancellationToken,
    ) -> ApplicationFuture<Value> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
}

pub(super) struct Personalization;

impl AppPersonalizationPort for Personalization {
    fn execute(
        &self,
        _: AppPersonalizationCommand,
        _: tokio_util::sync::CancellationToken,
    ) -> ApplicationFuture<AppPersonalizationResult> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
}

pub(super) struct SettingsMutation;

impl AppSettingsMutationPort for SettingsMutation {
    fn apply(&self, _: Value, _: Value) -> ApplicationFuture<()> {
        Box::pin(async { Ok(()) })
    }
}

impl AppContextReadPort for UnprovidedSessions {
    fn read(&self, _: AppContextReadQuery) -> ApplicationFuture<AppContextReadFacts> {
        Box::pin(async { Ok(test_context_facts()) })
    }
}

pub(super) fn test_context_facts() -> AppContextReadFacts {
    AppContextReadFacts {
        usage: None,
        compaction_summary: None,
        budget: AppContextBudgetFacts {
            context_window_tokens: 200_000,
            reserved_output_tokens: 8_000,
            reserved_tool_tokens: 8_000,
            compaction_prompt_reserve_tokens: 4_000,
            max_output_tokens: Some(8_000),
        },
    }
}

impl AppSessionWorkspaceProvisioner for UnprovidedSessions {
    fn provision(
        &self,
        _: AppSessionWorkspaceSnapshot,
        _: tokio_util::sync::CancellationToken,
    ) -> ApplicationFuture<()> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn branch_info(
        &self,
        _: AppSessionBranchQuery,
        _: tokio_util::sync::CancellationToken,
    ) -> ApplicationFuture<Value> {
        Box::pin(async {
            Ok(json!({
                "available": false,
                "workspace_mode": "none",
                "safe_status": "unavailable"
            }))
        })
    }
}

pub(super) struct UnprovidedBranchConversations;

impl crate::gateway::application::AppBranchConversationReader for UnprovidedBranchConversations {
    fn resolve_app_session(
        &self,
        _: String,
    ) -> crate::gateway::ApplicationFuture<Option<(String, String)>> {
        Box::pin(async { Ok(None) })
    }

    fn answer(
        &self,
        _: String,
    ) -> crate::gateway::ApplicationFuture<Option<crate::gateway::AppBranchCanonicalAnswer>> {
        Box::pin(async { Ok(None) })
    }

    fn context(&self, _: String, _: String) -> crate::gateway::ApplicationFuture<Option<String>> {
        Box::pin(async { Ok(None) })
    }
}

pub(super) struct TestBranchSummarizer;

impl crate::gateway::application::AppBranchSummarizer for TestBranchSummarizer {
    fn summarize(
        &self,
        _: crate::gateway::AppBranchSummaryInput,
        _: tokio_util::sync::CancellationToken,
    ) -> crate::gateway::ApplicationFuture<crate::gateway::AppBranchSummary> {
        Box::pin(async {
            Ok(crate::gateway::AppBranchSummary {
                text: "test summary".into(),
                excerpt_truncated: false,
            })
        })
    }
}

impl AppSessionWorkProgress for UnprovidedSessions {
    fn read(&self, _: String) -> ApplicationFuture<Option<AppWorkProgress>> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
}

impl AppWorkStreamReader for UnprovidedSessions {
    fn list_active(&self, _: AppWorkStreamQuery) -> ApplicationFuture<Value> {
        Box::pin(async { Ok(json!([])) })
    }

    fn reconcile_turn(&self, _: AppWorkStreamTurnOutcome) -> ApplicationFuture<()> {
        Box::pin(async { Ok(()) })
    }
}

impl AppSubsessionPort for UnprovidedSessions {
    fn projection(&self, _: String, _: Option<AppSessionViewPage>) -> ApplicationFuture<Value> {
        Box::pin(async { Ok(json!({"steward_children":[],"workers":[]})) })
    }
    fn cancel(&self, _: String, _: String) -> ApplicationFuture<Value> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn resume(&self, _: String, _: String) -> ApplicationFuture<Value> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn read_operation_output_chunks(
        &self,
        _: String,
        _: String,
        _: String,
    ) -> ApplicationFuture<Vec<super::super::operation_output::OperationOutputChunk>> {
        Box::pin(async { Ok(Vec::new()) })
    }
}

pub(super) struct Authority;

impl AppAuthorityHandoff for Authority {
    fn close_self_session(&self, _: String, _: String) -> ApplicationFuture<()> {
        Box::pin(async { Ok(()) })
    }
    fn list(&self, _: String) -> ApplicationFuture<AppAuthorityPage> {
        Box::pin(async {
            Ok(AppAuthorityPage {
                requests: vec![],
                permissions: vec![],
            })
        })
    }
    fn revoke(&self, _: String, _: String) -> ApplicationFuture<()> {
        Box::pin(async { Ok(()) })
    }
    fn decide(&self, input: AppAuthorityDecisionInput) -> ApplicationFuture<AppAuthorityDecision> {
        Box::pin(async move {
            Ok(AppAuthorityDecision {
                request_ref: input.request_ref,
                decision: "allowed".into(),
                admitted: true,
            })
        })
    }
    fn retry_decided(&self) -> ApplicationFuture<()> {
        Box::pin(async { Ok(()) })
    }
}

impl AppAdmissionAuthority for Admission {
    fn read_ledger_source(
        &self,
        _: AppLedgerSourceRequest,
    ) -> ApplicationFuture<AppSourceDocument> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn snapshot_source(
        &self,
        _: AppSourceSnapshotRequest,
    ) -> ApplicationFuture<MaterializedResponderFile> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn admit_visual(&self, request: VisualAdmissionRequest) -> ApplicationFuture<Value> {
        Box::pin(async move {
            Ok(Value::Array(
                request
                    .files
                    .into_iter()
                    .map(|file| Value::String(file.id))
                    .collect(),
            ))
        })
    }
}

pub(super) struct Native(pub(super) Mutex<Vec<NativeAppTurn>>);

impl AppNativeIngress for Native {
    fn enqueue(&self, turn: NativeAppTurn) -> ApplicationFuture<NativeEnqueueReceipt> {
        self.0.lock().unwrap().push(turn);
        Box::pin(async {
            Ok(NativeEnqueueReceipt {
                queue_id: "app:m1".into(),
            })
        })
    }
    fn find(&self, _: NativeAppTurn) -> ApplicationFuture<Option<NativeEnqueueReceipt>> {
        Box::pin(async { Ok(None) })
    }
    fn enqueue_cancel(&self, _: NativeAppCancellation) -> ApplicationFuture<NativeEnqueueReceipt> {
        Box::pin(async {
            Ok(NativeEnqueueReceipt {
                queue_id: "app:cancel-1".into(),
            })
        })
    }
}

pub(super) struct Assets;

impl AppNativeAssetResolver for Assets {
    fn resolve(&self, _: ClaimedNativeSnapshot) -> ApplicationFuture<ResolvedNativeAssets> {
        Box::pin(async {
            Ok(ResolvedNativeAssets {
                attachments: json!([]),
                image_admission: None,
                session_references: json!([]),
            })
        })
    }
}

pub(super) struct Ready;

impl AppExecutorReadiness for Ready {
    fn readiness(&self) -> Result<RuntimeReadinessView, GatewayApplicationError> {
        Ok(RuntimeReadinessView {
            authenticated_gateway_ready: true,
            btcc_executor_ready: true,
            executor_pid: Some(1),
            executor_ready_at: Some("now".into()),
            raw_text_included: false,
        })
    }
}

pub(super) struct Materializer;

impl AppArtifactMaterializer for Materializer {
    fn materialize(
        &self,
        _: ArtifactMaterializationRequest,
    ) -> ApplicationFuture<Vec<MaterializedResponderFile>> {
        Box::pin(async { Ok(Vec::new()) })
    }
}

impl AppMessageFileStorage for Materializer {
    fn write_upload(&self, _: AppFileWrite) -> ApplicationFuture<MaterializedResponderFile> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn prepare_uploaded(&self, _: AppMessageFileSnapshot) -> ApplicationFuture<()> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn read_original(&self, _: AppMessageFileSnapshot) -> ApplicationFuture<bytes::Bytes> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
}

pub(super) struct SettingsFacts;

impl AppSettingsFactsProvider for SettingsFacts {
    fn refresh(&self) -> ApplicationFuture<()> {
        Box::pin(async { Ok(()) })
    }

    fn snapshot(&self) -> Result<Arc<AppSettingsFacts>, GatewayApplicationError> {
        let model = AppModelMetadata {
            provider_id: "openai".into(),
            provider_family_id: None,
            model_id: "gpt-test".into(),
            model_ref: "openai/gpt-test".into(),
            context_window_tokens: Some(200_000),
            aliases: Arc::from([]),
            runtime_supported: true,
            registered: true,
            enabled: true,
            reasoning_efforts: Arc::from([ReasoningEffort::Medium]),
            default_reasoning_effort: ReasoningEffort::Medium,
        };
        Ok(Arc::new(AppSettingsFacts {
            registered_models: Arc::from([model.clone()]),
            known_models: Arc::from([model]),
            config_default_model: Some("openai/gpt-test".into()),
            config_model_fallback: AppModelFallbackFacts::default(),
            catalog_generation: "catalog-1".into(),
            native_settings: serde_json::json!({}),
        }))
    }
}

pub(super) struct Claims;

impl AppApprovalClaims for Claims {
    fn retains_claim(&self, _: String) -> ApplicationFuture<bool> {
        Box::pin(async { Ok(false) })
    }
}

pub(super) struct Liveness;

pub(super) struct UnprovidedMonitoring;

impl AppMonitoringPort for UnprovidedMonitoring {
    fn work_status(&self) -> ApplicationFuture<Vec<AppBoundWorkStatusFact>> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn usage_monitor(&self, _: AppUsageMonitorQuery) -> ApplicationFuture<Value> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn system_events(&self, _: AppMonitorPage) -> ApplicationFuture<Value> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn developer_logs(&self, _: AppDeveloperLogsQuery) -> ApplicationFuture<Value> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
}

impl AppQueueOwnerLiveness for Liveness {
    fn definitely_dead(&self, _: &str, _: &str) -> bool {
        false
    }
}

pub(super) fn dependencies(native: Arc<Native>, clock: u64) -> AppApplicationDependencies {
    AppApplicationDependencies {
        updates: test_updates(),
        skills: test_skills(),
        mcp_client: Arc::new(crate::mcp_client::NativeMcpClient::new(
            std::env::temp_dir().join(format!("butler-test-mcp-{}", uuid::Uuid::new_v4())),
            Default::default(),
        )),
        native_ingress: native,
        native_assets: Arc::new(Assets),
        executor_readiness: Arc::new(Ready),
        admission: Arc::new(Admission),
        artifact_materializer: Arc::new(Materializer),
        message_files: Arc::new(Materializer),
        settings_facts: Arc::new(SettingsFacts),
        settings_mutations: Arc::new(SettingsMutation),
        runtime_info: Arc::new(RuntimeInfo),
        model_catalog: Arc::new(ModelCatalog),
        personalization: Arc::new(Personalization),
        monitoring: Arc::new(UnprovidedMonitoring),
        project_dashboard_ledger: Arc::new(crate::gateway::TestProjectDashboardLedger),
        plan_decision_ledger: Arc::new(TestAppPlanDecisionLedger),
        project_dashboard_briefing: Arc::new(crate::gateway::TestProjectDashboardBriefing),
        relocation_host: Arc::new(UnprovidedRelocation),
        context_read: Arc::new(UnprovidedSessions),
        identity_clock: Arc::new(Clock(AtomicU64::new(clock))),
        approval_claims: Arc::new(Claims),
        queue_owner_liveness: Arc::new(Liveness),
        authority_handoff: Arc::new(Authority),
        session_workspaces: Arc::new(UnprovidedSessions),
        session_work_progress: Arc::new(UnprovidedSessions),
        work_streams: Arc::new(UnprovidedSessions),
        subsessions: Arc::new(UnprovidedSessions),
        branch_conversations: Arc::new(UnprovidedBranchConversations),
        branch_summarizer: Arc::new(TestBranchSummarizer),
    }
}

pub(super) fn test_updates() -> Arc<crate::operations::AppUpdateService> {
    let root = std::env::temp_dir().join(format!("butler-update-test-{}", uuid::Uuid::new_v4()));
    Arc::new(
        crate::operations::AppUpdateService::new(
            root.join("data"),
            root.join("installation"),
            Some("1.0.0".into()),
        )
        .unwrap(),
    )
}

pub(super) fn test_skills() -> Arc<crate::skills::NativeSkills> {
    let root = std::env::temp_dir().join(format!("butler-test-skills-{}", uuid::Uuid::new_v4()));
    Arc::new(crate::skills::NativeSkills::new(root.clone(), root))
}

pub(super) fn command(client: &str, text: &str) -> SendMessageCommand {
    SendMessageCommand {
        chat_id: "general".into(),
        request: MessageSendRequest {
            expected_project_id: None,
            content_parts: None,
            chat_id: Some(json!("general")),
            text: Some(json!(text)),
            client_message_id: Some(json!(client)),
            attachments: None,
            model: None,
            reasoning_effort: None,
            access_mode: None,
            plan_mode: None,
            subsession_result: None,
        },
    }
}

pub(super) fn temp_path(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "butler-h1b-{label}-{}-{}.sqlite",
        std::process::id(),
        Clock(AtomicU64::new(1)).new_uuid()
    ))
}
