//! One process-owned App HTTP listener and its App-only artifact file owner.

use std::net::SocketAddr;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use tokio::net::TcpListener;

use butler_gateway::gateway::AppApplication;
use butler_gateway::gateway::AppApplicationConfig;
use butler_gateway::gateway::AppApplicationDependencies;
use butler_gateway::gateway::AppIdentityClock;
use butler_gateway::gateway::AppMessageFiles;
use butler_gateway::gateway::GatewayApplicationError;
use butler_gateway::gateway::GatewayServer;
use butler_gateway::gateway::InboundQueue;
use butler_gateway::gateway::serve_gateway;
use butler_runtime::operations::ServiceReadiness;
use butler_turn::btcc::BtccError;

use crate::host::app::dashboard::AppDashboardLedger;
use crate::host::app::dashboard_briefing::AppDashboardBriefing;
use crate::host::app::plan_decision::AppPlanDecisionLedger;
use crate::host::app::runtime_ports::AppRuntimeInfo;
use crate::host::service::configuration::AppServiceConfiguration;
use crate::host::{
    AgentRuntime, AppAdmission, AppApprovalClaimsAdapter, AppAssets, AppBranchConversations,
    AppBranchSummarizerAdapter, AppContextRead, AppIngress, AppModelCatalog, AppMonitoring,
    AppQueueOwnerLivenessAdapter, AppReadiness, AppSessionProgress, AppSessionWorkspaces,
    AppSettingsFactsAdapter, AppSettingsMutation, AuthorityHandoff, ResolvedInstallation,
    SystemIdentity,
};

pub(crate) struct AppServer {
    listener: Option<GatewayServer>,
    /// Bound address, kept after the listener stops.
    address: SocketAddr,
    listener_ready: Arc<AtomicBool>,
    application: Arc<AppApplication>,
    artifacts: Arc<AppMessageFiles>,
}

impl AppServer {
    pub(crate) fn local_addr(&self) -> SocketAddr {
        self.address
    }

    pub(crate) async fn open(
        runtime: &AgentRuntime,
        data_root: &std::path::Path,
        installation: &ResolvedInstallation,
        app_config: &AppServiceConfiguration,
        queue: Arc<InboundQueue>,
        receipt: Arc<ServiceReadiness>,
    ) -> Result<Self, BtccError> {
        let artifacts = Arc::new(AppMessageFiles::new(data_root, Arc::new(SystemIdentity)));
        let result = Self::open_with_artifacts(
            runtime,
            data_root,
            installation,
            app_config,
            queue,
            receipt,
            artifacts.clone(),
        )
        .await;
        if result.is_err() {
            let _ = artifacts.close().await;
        }
        result
    }

    async fn open_with_artifacts(
        runtime: &AgentRuntime,
        data_root: &std::path::Path,
        installation: &ResolvedInstallation,
        app_config: &AppServiceConfiguration,
        queue: Arc<InboundQueue>,
        receipt: Arc<ServiceReadiness>,
        artifacts: Arc<AppMessageFiles>,
    ) -> Result<Self, BtccError> {
        let listener_ready = Arc::new(AtomicBool::new(false));
        let identity_clock: Arc<dyn AppIdentityClock> = Arc::new(SystemIdentity);
        let settings = Arc::new(
            AppSettingsFactsAdapter::open(
                runtime.models.configuration.clone(),
                runtime.profile.clone(),
                data_root.to_path_buf(),
                format!("http://{}:{}", app_config.host, app_config.port),
                "local".into(),
            )
            .await
            .map_err(app_error)?,
        );
        let session_workspaces = Arc::new(AppSessionWorkspaces::new(
            runtime.bindings.clone(),
            runtime.session_worktrees.clone(),
            runtime.workspace_recovery.clone(),
            runtime.subsessions.clone(),
            runtime.conversations.clone(),
        ));
        let dependencies = AppApplicationDependencies {
            updates: Arc::new(
                crate::host::cli::update::open_app_update(data_root, installation).map_err(
                    |code| {
                        BtccError::relayed(code.to_string(), "App update service is unavailable")
                    },
                )?,
            ),
            skills: runtime.skills.clone(),
            mcp_client: runtime.mcp_client.clone(),
            native_ingress: Arc::new(AppIngress::new(queue.clone())),
            native_assets: Arc::new(AppAssets::new(
                runtime.conversations.clone(),
                runtime.image_files.clone(),
                runtime.models.configuration.clone(),
                runtime.mcp_client.clone(),
                data_root,
            )),
            executor_readiness: Arc::new(AppReadiness::new(receipt, listener_ready.clone())),
            admission: Arc::new(AppAdmission::new(
                runtime.project_ledger.clone(),
                runtime.image_files.clone(),
                runtime.models.configuration.clone(),
                runtime.mcp_client.clone(),
                artifacts.clone(),
            )),
            artifact_materializer: artifacts.clone(),
            message_files: artifacts.clone(),
            settings_facts: settings.clone(),
            settings_mutations: Arc::new(AppSettingsMutation::new(
                runtime.models.configuration.clone(),
                runtime.profile.clone(),
                installation.clone(),
                data_root.to_path_buf(),
            )),
            runtime_info: Arc::new(AppRuntimeInfo::open(installation)),
            model_catalog: Arc::new(AppModelCatalog::new(
                runtime.models.configuration.clone(),
                settings,
                installation.clone(),
                data_root.to_path_buf(),
            )),
            personalization: Arc::new(crate::host::AppPersonalization::new(
                runtime.profile.clone(),
                runtime.models.configuration.clone(),
                installation.clone(),
                data_root.to_path_buf(),
                identity_clock.clone(),
            )),
            monitoring: Arc::new(AppMonitoring::new(
                data_root.to_path_buf(),
                runtime.session_work.clone(),
            )),
            context_read: Arc::new(AppContextRead::new(
                data_root.to_path_buf(),
                runtime.context_budget.clone(),
                runtime.context_compactions.clone(),
            )),
            identity_clock,
            approval_claims: Arc::new(AppApprovalClaimsAdapter::new(runtime.authority.clone())),
            queue_owner_liveness: Arc::new(AppQueueOwnerLivenessAdapter),
            authority_handoff: Arc::new(AuthorityHandoff::new(
                runtime.authority.clone(),
                queue,
                Arc::new(|| {
                    butler_models::models::ModelConfigurationClock::now_iso(&SystemIdentity)
                }),
            )),
            session_workspaces: session_workspaces.clone(),
            relocation_host: session_workspaces,
            session_work_progress: Arc::new(AppSessionProgress::new(
                runtime.session_work.clone(),
                runtime.project_ledger.clone(),
            )),
            project_dashboard_ledger: Arc::new(AppDashboardLedger::new(
                runtime.project_ledger.clone(),
            )),
            project_dashboard_briefing: Arc::new(AppDashboardBriefing::new(
                &runtime.models,
                data_root,
            )),
            plan_decision_ledger: Arc::new(AppPlanDecisionLedger::new(
                runtime.project_ledger.clone(),
            )),
            work_streams: runtime.work_streams.clone(),
            subsessions: Arc::new(crate::host::AppSubsessions::new(
                runtime.subsessions.clone(),
                runtime.conversations.clone(),
                runtime.progress.clone(),
            )),
            branch_conversations: Arc::new(AppBranchConversations::new(
                runtime.conversations.clone(),
            )),
            branch_summarizer: Arc::new(AppBranchSummarizerAdapter::new(&runtime.models)),
        };
        let application = Arc::new(
            AppApplication::open(
                AppApplicationConfig {
                    database_path: app_config.db_path.clone(),
                    butler_data: data_root.to_path_buf(),
                    project_workspace_root: data_root.join("workspaces/projects"),
                    folder_selection_secret: app_config.folder_selection_secret.clone(),
                },
                dependencies,
            )
            .await
            .map_err(app_error)?,
        );
        let listener = match TcpListener::bind((app_config.host.as_str(), app_config.port)).await {
            Ok(listener) => listener,
            Err(error) => {
                let _ = application.close().await;
                return Err(BtccError::relayed(
                    "app_listener_bind_failed",
                    error.to_string(),
                ));
            }
        };
        let mut gateway_config = app_config.gateway_config();
        gateway_config.static_ui_root = Some(installation.resources().join("app-client/dist"));
        let server = match serve_gateway(listener, application.clone(), gateway_config) {
            Ok(server) => server,
            Err(error) => {
                let _ = application.close().await;
                return Err(BtccError::relayed(
                    "app_listener_start_failed",
                    error.to_string(),
                ));
            }
        };
        listener_ready.store(true, Ordering::Release);
        if let Err(error) = application.start_dispatch().await {
            listener_ready.store(false, Ordering::Release);
            let _ = server.close().await;
            let _ = application.close().await;
            return Err(app_error(error));
        }
        Ok(Self {
            address: server.local_addr(),
            listener: Some(server),
            listener_ready,
            application,
            artifacts,
        })
    }

    /// Stop HTTP admission before the process drains its native inbound queue.
    pub(crate) async fn stop_listener(&mut self) -> Result<(), BtccError> {
        self.listener_ready.store(false, Ordering::Release);
        self.application.cancel_updates();
        let listener = match self.listener.take() {
            Some(server) => server.close().await.map_err(|error| {
                BtccError::relayed("app_listener_close_failed", error.to_string())
                    .with_source(error)
            }),
            None => Ok(()),
        };
        let dispatch = self.application.stop_dispatch().await.map_err(app_error);
        listener.and(dispatch)
    }

    /// Drain the App projection and its file jobs before native runtime owners.
    pub(crate) async fn close_application(&mut self) -> Result<(), BtccError> {
        let listener = self.stop_listener().await;
        let application = self.application.close().await.map_err(app_error);
        let artifacts = self.artifacts.close().await.map_err(app_error);
        listener.and(application).and(artifacts)
    }
}

impl Drop for AppServer {
    fn drop(&mut self) {
        self.listener_ready.store(false, Ordering::Release);
    }
}

fn app_error(error: GatewayApplicationError) -> BtccError {
    match error {
        GatewayApplicationError::Public { code, message, .. } => BtccError::relayed(code, message),
        GatewayApplicationError::Internal { .. } => {
            BtccError::relayed("app_application_failed", "App application is unavailable")
        }
    }
}
