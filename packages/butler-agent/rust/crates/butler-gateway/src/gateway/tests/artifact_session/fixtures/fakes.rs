mod message_files;
use super::*;
mod sessions;
use sessions::TestSessions;

struct TestMonitoring;

struct TestRelocation;

impl crate::gateway::AppRelocationHost for TestRelocation {
    fn inspect(&self, _: String) -> ApplicationFuture<crate::gateway::AppRelocationSnapshot> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn ensure_binding(
        &self,
        _: crate::gateway::AppRelocationBindingSeed,
    ) -> ApplicationFuture<crate::gateway::AppRelocationBinding> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn plan_workspace(
        &self,
        _: crate::gateway::AppRelocationWorkspaceRequest,
    ) -> ApplicationFuture<crate::gateway::AppRelocationWorkspacePlan> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn prepare_workspace(
        &self,
        _: crate::gateway::AppRelocationWorkspacePlan,
    ) -> ApplicationFuture<crate::gateway::AppRelocationWorkspacePlan> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn compare_and_set_binding(
        &self,
        _: crate::gateway::AppRelocationBindingUpdate,
    ) -> ApplicationFuture<crate::gateway::AppRelocationBindingResult> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn sync_conversation_context(
        &self,
        _: crate::gateway::AppRelocationCanonicalUpdate,
    ) -> ApplicationFuture<()> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn discard_workspace(
        &self,
        _: crate::gateway::AppRelocationWorkspacePlan,
    ) -> ApplicationFuture<bool> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
}

impl crate::gateway::AppMonitoringPort for TestMonitoring {
    fn work_status(&self) -> ApplicationFuture<Vec<crate::gateway::AppBoundWorkStatusFact>> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn usage_monitor(&self, _: crate::gateway::AppUsageMonitorQuery) -> ApplicationFuture<Value> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn system_events(&self, _: crate::gateway::AppMonitorPage) -> ApplicationFuture<Value> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn developer_logs(&self, _: crate::gateway::AppDeveloperLogsQuery) -> ApplicationFuture<Value> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
}

pub(super) fn test_dependencies() -> AppApplicationDependencies {
    let root =
        std::env::temp_dir().join(format!("butler-artifact-skills-{}", uuid::Uuid::new_v4()));
    AppApplicationDependencies {
        hooks: None,
        service_shutdown: tokio_util::sync::CancellationToken::new(),
        updates: Arc::new(
            butler_runtime::operations::AppUpdateService::new(
                root.join("update-data"),
                root.join("installation"),
                Some("1.0.0".into()),
            )
            .unwrap(),
        ),
        skills: Arc::new(butler_runtime::skills::Skills::new(root.clone(), root)),
        mcp_client: Arc::new(butler_models::mcp_client::McpClient::new(
            std::env::temp_dir().join(format!("butler-artifact-mcp-{}", uuid::Uuid::new_v4())),
            Default::default(),
        )),
        native_ingress: Arc::new(TestNative),
        native_assets: Arc::new(TestAssets),
        executor_readiness: Arc::new(TestReadiness),
        admission: Arc::new(TestAdmission),
        artifact_materializer: Arc::new(TestMaterializer),
        message_files: Arc::new(TestMaterializer),
        settings_facts: Arc::new(TestSettings),
        settings_mutations: Arc::new(TestSettingsMutation),
        runtime_info: Arc::new(TestRuntimeInfo),
        model_catalog: Arc::new(TestModelCatalog),
        personalization: Arc::new(TestPersonalization),
        memory_management: Arc::new(super::memory_management::TestMemory),
        monitoring: Arc::new(TestMonitoring),
        project_dashboard_ledger: Arc::new(crate::gateway::TestProjectDashboardLedger),
        plan_decision_ledger: Arc::new(crate::gateway::application::TestAppPlanDecisionLedger),
        project_dashboard_briefing: Arc::new(crate::gateway::TestProjectDashboardBriefing),
        relocation_host: Arc::new(TestRelocation),
        context_read: Arc::new(TestContextRead),
        identity_clock: Arc::new(TestClock(AtomicU64::new(1))),
        approval_claims: Arc::new(TestClaims),
        queue_owner_liveness: Arc::new(TestLiveness),
        authority_handoff: Arc::new(TestAuthority),
        session_workspaces: Arc::new(TestSessions),
        session_work_progress: Arc::new(TestSessions),
        work_streams: Arc::new(TestSessions),
        subsessions: Arc::new(TestSessions),
        branch_conversations: Arc::new(TestBranchConversations),
        branch_summarizer: Arc::new(TestBranchSummarizer),
        setup: crate::gateway::application::test_setup_port(),
    }
}

struct TestModelCatalog;

struct TestPersonalization;

impl crate::gateway::AppPersonalizationPort for TestPersonalization {
    fn execute(
        &self,
        _: crate::gateway::AppPersonalizationCommand,
        _: tokio_util::sync::CancellationToken,
    ) -> crate::gateway::ApplicationFuture<crate::gateway::AppPersonalizationResult> {
        Box::pin(async { Err(crate::gateway::GatewayApplicationError::internal()) })
    }
}

impl crate::gateway::AppModelCatalogPort for TestModelCatalog {
    fn execute(
        &self,
        _: crate::gateway::AppModelCatalogCommand,
        _: tokio_util::sync::CancellationToken,
    ) -> crate::gateway::ApplicationFuture<Value> {
        Box::pin(async { Err(crate::gateway::GatewayApplicationError::internal()) })
    }
}

struct TestBranchConversations;

impl crate::gateway::application::AppBranchConversationReader for TestBranchConversations {
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

struct TestBranchSummarizer;

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

struct TestContextRead;

impl AppContextReadPort for TestContextRead {
    fn read(&self, _: AppContextReadQuery) -> ApplicationFuture<AppContextReadFacts> {
        Box::pin(async {
            Ok(AppContextReadFacts {
                usage: Some(AppContextUsage {
                    prompt_tokens: 1234,
                    source: "provider_prompt_usage".into(),
                }),
                compaction_summary: None,
                session_usage: None,
                auth_mode: butler_models::models::UsageAuthMode::Unknown,
                configuration: None,
                budget: AppContextBudgetFacts {
                    context_window_tokens: 200_000,
                    reserved_output_tokens: 8_000,
                    reserved_tool_tokens: 8_000,
                    compaction_prompt_reserve_tokens: 4_000,
                    max_output_tokens: Some(8_000),
                },
            })
        })
    }
}

static NEXT_DB: AtomicU64 = AtomicU64::new(1);

pub(crate) fn test_db_path() -> PathBuf {
    std::env::temp_dir().join(format!(
        "butler-artifact-route-{}-{}.sqlite",
        std::process::id(),
        NEXT_DB.fetch_add(1, Ordering::Relaxed)
    ))
}

struct TestClock(AtomicU64);

impl AppIdentityClock for TestClock {
    fn new_uuid(&self) -> String {
        format!(
            "00000000-0000-4000-8000-{:012x}",
            self.0.fetch_add(1, Ordering::Relaxed)
        )
    }

    fn now_iso(&self) -> String {
        "2026-09-14T00:00:00.000Z".into()
    }

    fn iso_after_millis(&self, _: u64) -> String {
        "2026-09-14T00:01:00.000Z".into()
    }
}

struct TestNative;

impl AppNativeIngress for TestNative {
    fn enqueue(&self, _: AppTurn) -> ApplicationFuture<EnqueueReceipt> {
        Box::pin(async {
            Ok(EnqueueReceipt {
                queue_id: "test-queue".into(),
            })
        })
    }

    fn find(&self, _: AppTurn) -> ApplicationFuture<Option<EnqueueReceipt>> {
        Box::pin(async { Ok(None) })
    }
}

struct TestAssets;

impl AppNativeAssetResolver for TestAssets {
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

struct TestReadiness;

impl AppExecutorReadiness for TestReadiness {
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

struct TestAdmission;

impl AppAdmissionAuthority for TestAdmission {
    fn read_ledger_source(
        &self,
        _: AppLedgerSourceRequest,
    ) -> ApplicationFuture<AppSourceDocument> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }

    fn snapshot_source(
        &self,
        _: AppSourceSnapshotRequest,
    ) -> ApplicationFuture<MaterializedResponderFile> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
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

struct TestMaterializer;

impl AppArtifactMaterializer for TestMaterializer {
    fn materialize(
        &self,
        _: ArtifactMaterializationRequest,
    ) -> ApplicationFuture<Vec<MaterializedResponderFile>> {
        Box::pin(async { Ok(Vec::new()) })
    }
}

struct TestSettings;
struct TestSettingsMutation;

impl AppSettingsMutationPort for TestSettingsMutation {
    fn apply(&self, _: Value, _: Value) -> crate::gateway::ApplicationFuture<()> {
        Box::pin(async { Ok(()) })
    }
}

struct TestRuntimeInfo;

impl AppRuntimeInfoProvider for TestRuntimeInfo {
    fn app_version(&self) -> Result<String, GatewayApplicationError> {
        Ok("1.0.0".into())
    }
}

impl AppSettingsFactsProvider for TestSettings {
    fn refresh(&self) -> ApplicationFuture<()> {
        Box::pin(async { Ok(()) })
    }

    fn snapshot(&self) -> Result<Arc<AppSettingsFacts>, GatewayApplicationError> {
        let model = AppModelMetadata {
            provider_id: "openai".into(),
            provider_family_id: None,
            model_id: "gpt-5.5".into(),
            model_ref: "openai/gpt-5.5".into(),
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
            config_default_model: Some("openai/gpt-5.5".into()),
            config_model_fallback: Default::default(),
            catalog_generation: "test".into(),
            native_settings: serde_json::json!({}),
            routine_presets: Arc::from([]),
        }))
    }
}

struct TestClaims;

impl AppApprovalClaims for TestClaims {
    fn retains_claim(&self, _: String) -> ApplicationFuture<bool> {
        Box::pin(async { Ok(false) })
    }
}

struct TestLiveness;

impl AppQueueOwnerLiveness for TestLiveness {
    fn definitely_dead(&self, _: &str, _: &str) -> bool {
        false
    }
}

struct TestAuthority;

impl AppAuthorityHandoff for TestAuthority {
    fn session_requests(
        &self,
        _: String,
        _: Vec<String>,
    ) -> ApplicationFuture<(Vec<serde_json::Value>, Vec<serde_json::Value>)> {
        Box::pin(async { Ok((vec![], vec![])) })
    }

    fn close_self_session(&self, _: String, _: String) -> ApplicationFuture<()> {
        Box::pin(async { Ok(()) })
    }
    fn list_all_permissions(&self) -> ApplicationFuture<Vec<crate::gateway::AppGrantView>> {
        Box::pin(async { Ok(vec![]) })
    }
    fn revoke_permissions(&self, _: Vec<crate::gateway::AppGrantRef>) -> ApplicationFuture<()> {
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
                question_followup: None,
            })
        })
    }

    fn retry_decided(&self) -> ApplicationFuture<Vec<(String, String, String)>> {
        Box::pin(async { Ok(vec![]) })
    }
    fn settle_question_followup(&self, _: String) -> ApplicationFuture<()> {
        Box::pin(async { Ok(()) })
    }
}
