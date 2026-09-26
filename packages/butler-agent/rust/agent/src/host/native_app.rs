//! One process-owned App HTTP listener and its App-only artifact file owner.

use std::net::SocketAddr;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use tokio::net::TcpListener;

use crate::{
    btcc::BtccError,
    gateway::{
        AppApplication, AppApplicationConfig, AppApplicationDependencies, AppIdentityClock,
        GatewayApplicationError, GatewayServer, NativeAppMessageFiles, NativeInboundQueue,
        serve_gateway,
    },
    operations::ServiceReadiness,
};

use super::app_runtime_ports::NativeAppRuntimeInfo;
use super::native_app_dashboard::NativeAppDashboardLedger;
use super::native_app_dashboard_briefing::NativeAppDashboardBriefing;
use super::native_app_plan_decision::NativeAppPlanDecisionLedger;
use super::service_configuration::NativeAppServiceConfiguration;
use super::{
    NativeAgentRuntime, NativeAppAdmission, NativeAppApprovalClaims, NativeAppAssets,
    NativeAppBranchConversations, NativeAppBranchSummarizer, NativeAppContextRead,
    NativeAppIngress, NativeAppModelCatalog, NativeAppMonitoring, NativeAppQueueOwnerLiveness,
    NativeAppReadiness, NativeAppSessionProgress, NativeAppSessionWorkspaces,
    NativeAppSettingsFacts, NativeAppSettingsMutation, NativeAuthorityHandoff,
    ResolvedInstallation, SystemIdentity,
};

pub(crate) struct NativeAppServer {
    listener: Option<GatewayServer>,
    /// Bound address, kept after the listener stops.
    address: SocketAddr,
    listener_ready: Arc<AtomicBool>,
    application: Arc<AppApplication>,
    artifacts: Arc<NativeAppMessageFiles>,
}

impl NativeAppServer {
    pub(crate) fn local_addr(&self) -> SocketAddr {
        self.address
    }

    pub(crate) async fn open(
        runtime: &NativeAgentRuntime,
        data_root: &std::path::Path,
        installation: &ResolvedInstallation,
        app_config: &NativeAppServiceConfiguration,
        queue: Arc<NativeInboundQueue>,
        receipt: Arc<ServiceReadiness>,
    ) -> Result<Self, BtccError> {
        let artifacts = Arc::new(NativeAppMessageFiles::new(
            data_root.to_path_buf(),
            Arc::new(SystemIdentity),
        ));
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
        runtime: &NativeAgentRuntime,
        data_root: &std::path::Path,
        installation: &ResolvedInstallation,
        app_config: &NativeAppServiceConfiguration,
        queue: Arc<NativeInboundQueue>,
        receipt: Arc<ServiceReadiness>,
        artifacts: Arc<NativeAppMessageFiles>,
    ) -> Result<Self, BtccError> {
        let listener_ready = Arc::new(AtomicBool::new(false));
        let identity_clock: Arc<dyn AppIdentityClock> = Arc::new(SystemIdentity);
        let settings = Arc::new(
            NativeAppSettingsFacts::open(
                runtime.models.configuration.clone(),
                runtime.profile.clone(),
                data_root.to_path_buf(),
                format!("http://{}:{}", app_config.host, app_config.port),
                "local".into(),
            )
            .await
            .map_err(app_error)?,
        );
        let session_workspaces = Arc::new(NativeAppSessionWorkspaces::new(
            runtime.bindings.clone(),
            runtime.session_worktrees.clone(),
            runtime.workspace_recovery.clone(),
            runtime.subsessions.clone(),
            runtime.conversations.clone(),
        ));
        let dependencies = AppApplicationDependencies {
            updates: Arc::new(
                super::update_cli::open_app_update(data_root.to_path_buf(), installation)
                    .map_err(|code| BtccError::new(code, "App update service is unavailable"))?,
            ),
            skills: runtime.skills.clone(),
            mcp_client: runtime.mcp_client.clone(),
            native_ingress: Arc::new(NativeAppIngress::new(queue.clone())),
            native_assets: Arc::new(NativeAppAssets::new(
                runtime.conversations.clone(),
                runtime.image_files.clone(),
                runtime.models.configuration.clone(),
                runtime.mcp_client.clone(),
                data_root.to_path_buf(),
            )),
            executor_readiness: Arc::new(NativeAppReadiness::new(receipt, listener_ready.clone())),
            admission: Arc::new(NativeAppAdmission::new(
                runtime.project_ledger.clone(),
                runtime.image_files.clone(),
                runtime.models.configuration.clone(),
                runtime.mcp_client.clone(),
                artifacts.clone(),
            )),
            artifact_materializer: artifacts.clone(),
            message_files: artifacts.clone(),
            settings_facts: settings.clone(),
            settings_mutations: Arc::new(NativeAppSettingsMutation::new(
                runtime.models.configuration.clone(),
                runtime.profile.clone(),
                installation.clone(),
                data_root.to_path_buf(),
            )),
            runtime_info: Arc::new(NativeAppRuntimeInfo::open(installation)),
            model_catalog: Arc::new(NativeAppModelCatalog::new(
                runtime.models.configuration.clone(),
                settings,
                installation.clone(),
                data_root.to_path_buf(),
            )),
            personalization: Arc::new(super::NativeAppPersonalization::new(
                runtime.profile.clone(),
                runtime.models.configuration.clone(),
                installation.clone(),
                data_root.to_path_buf(),
                identity_clock.clone(),
            )),
            monitoring: Arc::new(NativeAppMonitoring::new(
                data_root.to_path_buf(),
                runtime.session_work.clone(),
            )),
            context_read: Arc::new(NativeAppContextRead::new(
                data_root.to_path_buf(),
                runtime.context_budget.clone(),
                runtime.context_compactions.clone(),
            )),
            identity_clock,
            approval_claims: Arc::new(NativeAppApprovalClaims::new(runtime.authority.clone())),
            queue_owner_liveness: Arc::new(NativeAppQueueOwnerLiveness),
            authority_handoff: Arc::new(NativeAuthorityHandoff::new(
                runtime.authority.clone(),
                queue,
                Arc::new(|| crate::models::ModelConfigurationClock::now_iso(&SystemIdentity)),
            )),
            session_workspaces: session_workspaces.clone(),
            relocation_host: session_workspaces,
            session_work_progress: Arc::new(NativeAppSessionProgress::new(
                runtime.session_work.clone(),
                runtime.project_ledger.clone(),
            )),
            project_dashboard_ledger: Arc::new(NativeAppDashboardLedger::new(
                runtime.project_ledger.clone(),
            )),
            project_dashboard_briefing: Arc::new(NativeAppDashboardBriefing::new(
                &runtime.models,
                data_root,
            )),
            plan_decision_ledger: Arc::new(NativeAppPlanDecisionLedger::new(
                runtime.project_ledger.clone(),
            )),
            work_streams: runtime.work_streams.clone(),
            subsessions: Arc::new(super::NativeAppSubsessions::new(
                runtime.subsessions.clone(),
                runtime.conversations.clone(),
                runtime.progress.clone(),
            )),
            branch_conversations: Arc::new(NativeAppBranchConversations::new(
                runtime.conversations.clone(),
            )),
            branch_summarizer: Arc::new(NativeAppBranchSummarizer::new(&runtime.models)),
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
                return Err(BtccError::new(
                    "app_listener_bind_failed",
                    error.to_string(),
                ));
            }
        };
        let mut gateway_config = app_config.gateway_config();
        gateway_config.static_ui_root = Some(installation.resources().join("app-client/dist"));
        let server = match serve_gateway(listener, application.clone(), gateway_config).await {
            Ok(server) => server,
            Err(error) => {
                let _ = application.close().await;
                return Err(BtccError::new(
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
            Some(server) => server
                .close()
                .await
                .map_err(|error| BtccError::new("app_listener_close_failed", error.to_string())),
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

impl Drop for NativeAppServer {
    fn drop(&mut self) {
        self.listener_ready.store(false, Ordering::Release);
    }
}

fn app_error(error: GatewayApplicationError) -> BtccError {
    match error {
        GatewayApplicationError::Public { code, message, .. } => BtccError::new(code, message),
        GatewayApplicationError::Internal => {
            BtccError::new("app_application_failed", "App application is unavailable")
        }
    }
}
