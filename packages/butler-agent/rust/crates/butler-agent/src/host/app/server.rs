//! One process-owned App HTTP listener and its App-only artifact file owner.

mod security_store;
mod startup;

use std::net::SocketAddr;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use tokio::net::TcpListener;

use butler_gateway::gateway::{
    AppApplication, AppApplicationConfig, AppApplicationDependencies, AppIdentityClock,
    AppMessageFiles, GatewayApplicationError, GatewayConfig, GatewayServer, InboundQueue,
    LocalAuthConfig,
};
use butler_runtime::operations::ServiceReadiness;
use butler_turn::btcc::BtccError;

use crate::host::app::dashboard::AppDashboardLedger;
use crate::host::app::dashboard_briefing::AppDashboardBriefing;
use crate::host::app::plan_decision::AppPlanDecisionLedger;
use crate::host::app::runtime_ports::AppRuntimeInfo;
use crate::host::app::runtime_ports::{AppSetup, AppSetupParts};
use crate::host::service::configuration::AppServiceConfiguration;
use crate::host::{
    AgentRuntime, AppAdmission, AppApprovalClaimsAdapter, AppAssets, AppBranchConversations,
    AppBranchSummarizerAdapter, AppContextRead, AppIngress, AppModelCatalog, AppMonitoring,
    AppQueueOwnerLivenessAdapter, AppReadiness, AppSessionProgress, AppSessionWorkspaces,
    AppSettingsFactsAdapter, AppSettingsMutation, AuthorityHandoff, ResolvedInstallation,
    SystemIdentity,
};
use security_store::AppSecurityStore;
#[cfg(debug_assertions)]
mod startup_hold;

pub(crate) struct AppServer {
    listener: Option<GatewayServer>,
    /// Bound address, kept after the listener stops.
    address: SocketAddr,
    listener_ready: Arc<AtomicBool>,
    application: Arc<AppApplication>,
    artifacts: Arc<AppMessageFiles>,
    setup: AppSetup,
}

/// What the process owns and hands every App server it starts.
pub(crate) struct AppServerOwners {
    pub(crate) queue: Arc<InboundQueue>,
    pub(crate) writer: Arc<butler_gateway::gateway::TranscriptWriter>,
    pub(crate) receipt: Arc<ServiceReadiness>,
    /// The process's token, shared with its other gateway clients, so a
    /// rotated connection code reaches all of them.
    pub(crate) local_auth: LocalAuthConfig,
}

impl AppServer {
    pub(crate) async fn effective_default_model(&self) -> Result<String, BtccError> {
        use butler_gateway::gateway::GatewayApplication;
        let settings =
            self.application.read_settings().await.map_err(|error| {
                BtccError::relayed("default_model_unavailable", error.to_string())
            })?;
        settings["model"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| {
                BtccError::relayed("default_model_unavailable", "Settings has no default model")
            })
    }

    pub(crate) fn local_addr(&self) -> SocketAddr {
        self.address
    }

    /// Reserve the address before any startup persistence or runtime DB opens.
    pub(crate) async fn bind(host: &str, port: u16) -> Result<TcpListener, BtccError> {
        TcpListener::bind((host, port)).await.map_err(|error| {
            BtccError::relayed(
                "app_listener_bind_failed",
                format!("{host}:{port}: {error}"),
            )
        })
    }

    pub(crate) async fn open(
        runtime: &AgentRuntime,
        data_root: &std::path::Path,
        installation: &ResolvedInstallation,
        app_config: &AppServiceConfiguration,
        owners: AppServerOwners,
        listener: TcpListener,
    ) -> Result<Self, BtccError> {
        let artifacts = Arc::new(AppMessageFiles::new(
            data_root,
            super::schedule_clock::clock(),
        ));
        let result = Self::open_with_artifacts(
            runtime,
            data_root,
            installation,
            app_config,
            owners,
            artifacts.clone(),
            listener,
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
        owners: AppServerOwners,
        artifacts: Arc<AppMessageFiles>,
        listener: TcpListener,
    ) -> Result<Self, BtccError> {
        let listener_ready = Arc::new(AtomicBool::new(false));
        let identity_clock: Arc<dyn AppIdentityClock> = super::schedule_clock::clock();
        let address = listener.local_addr().map_err(|error| {
            BtccError::relayed("app_listener_address_failed", error.to_string())
        })?;
        let settings = Arc::new(open_settings(runtime, data_root, address).await?);
        let setup = owners.start_setup(runtime, settings.clone(), installation, data_root);
        let session_workspaces = Arc::new(AppSessionWorkspaces::new(
            runtime.bindings.clone(),
            runtime.session_worktrees.clone(),
            runtime.workspace_recovery.clone(),
            runtime.subsessions.clone(),
            runtime.conversations.clone(),
        ));
        let dependencies = AppApplicationDependencies {
            service_shutdown: runtime.service_shutdown.clone(),
            updates: Arc::new(open_updates(data_root, installation)?),
            setup: Arc::new(setup.clone()),
            skills: runtime.skills.clone(),
            mcp_client: runtime.mcp_client.clone(),
            native_ingress: Arc::new(AppIngress::new(owners.queue.clone())),
            native_assets: Arc::new(AppAssets::new(
                runtime.conversations.clone(),
                runtime.image_files.clone(),
                runtime.models.configuration.clone(),
                runtime.mcp_client.clone(),
                data_root,
            )),
            executor_readiness: Arc::new(AppReadiness::new(owners.receipt, listener_ready.clone())),
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
            monitoring: Arc::new(AppMonitoring::for_runtime(runtime, data_root)),
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
                owners.queue,
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
        let application =
            open_application(app_config, data_root, dependencies, &owners.writer).await?;
        let gateway_config = gateway_config(app_config, data_root, installation, owners.local_auth);
        let server = startup::activate(
            listener,
            application.clone(),
            gateway_config,
            &setup,
            &listener_ready,
            data_root,
        )
        .await?;
        Ok(Self {
            address: server.local_addr(),
            listener: Some(server),
            listener_ready,
            application,
            artifacts,
            setup,
        })
    }

    pub(crate) async fn stop_accepting(&self) -> Result<(), BtccError> {
        if let Some(listener) = &self.listener {
            listener.stop_accepting();
        }
        let queue = self
            .application
            .stop_queue_dispatch()
            .await
            .map_err(app_error);
        self.listener_ready.store(false, Ordering::Release);
        queue
    }

    /// Stop HTTP admission before the process drains its native inbound queue.
    pub(crate) async fn stop_listener(&mut self) -> Result<(), BtccError> {
        let queue = self.stop_accepting().await;
        self.listener_ready.store(false, Ordering::Release);
        self.application.cancel_updates();
        let listener = match self.listener.take() {
            Some(server) => server.close().await.map_err(|error| {
                BtccError::relayed("app_listener_close_failed", error.to_string())
                    .with_source(error)
            }),
            None => Ok(()),
        };
        let projection = self.application.drain_projection().await.map_err(app_error);
        let dispatch = self.application.stop_dispatch().await.map_err(app_error);
        queue.and(listener).and(projection).and(dispatch)
    }

    /// Drain the App projection and its file jobs before native runtime owners.
    pub(crate) async fn close_application(&mut self) -> Result<(), BtccError> {
        let listener =
            crate::host::service::shutdown_trace::measure("app_admission", self.stop_listener())
                .await;
        crate::host::service::shutdown_trace::measure("app_setup_join", self.setup.close()).await;
        let application = self.application.close().await.map_err(app_error);
        let artifacts = crate::host::service::shutdown_trace::measure(
            "app_artifacts_join",
            self.artifacts.close(),
        )
        .await
        .map_err(app_error);
        listener.and(application).and(artifacts)
    }
}

async fn open_application(
    config: &AppServiceConfiguration,
    data_root: &std::path::Path,
    dependencies: AppApplicationDependencies,
    writer: &butler_gateway::gateway::TranscriptWriter,
) -> Result<Arc<AppApplication>, BtccError> {
    let application = Arc::new(
        AppApplication::open(
            AppApplicationConfig {
                database_path: config.db_path.clone(),
                butler_data: data_root.to_path_buf(),
                project_workspace_root: data_root.join("workspaces/projects"),
                folder_selection_secret: config.folder_selection_secret.clone(),
            },
            dependencies,
        )
        .await
        .map_err(app_error)?,
    );
    writer.observe_appends(application.transcript_append_listener());
    Ok(application)
}

impl Drop for AppServer {
    fn drop(&mut self) {
        self.listener_ready.store(false, Ordering::Release);
    }
}

/// The listener configuration: the captured settings with the process's
/// token, the bundled UI and the Settings → Security store.
fn gateway_config(
    app_config: &AppServiceConfiguration,
    data_root: &std::path::Path,
    installation: &ResolvedInstallation,
    local_auth: LocalAuthConfig,
) -> GatewayConfig {
    let mut config = app_config.gateway_config();
    config.local_auth = local_auth;
    config.static_ui_root = Some(installation.resources().join("app-client/dist"));
    config.security_store = Some(Arc::new(AppSecurityStore::new(
        data_root.to_path_buf(),
        installation.clone(),
    )));
    config
}

async fn open_settings(
    runtime: &AgentRuntime,
    data_root: &std::path::Path,
    address: SocketAddr,
) -> Result<AppSettingsFactsAdapter, BtccError> {
    AppSettingsFactsAdapter::open(
        runtime.models.configuration.clone(),
        runtime.profile.clone(),
        data_root.to_path_buf(),
        format!("http://{address}"),
        "local".into(),
    )
    .await
    .map_err(app_error)
}

fn open_updates(
    data_root: &std::path::Path,
    installation: &ResolvedInstallation,
) -> Result<butler_runtime::operations::AppUpdateService, BtccError> {
    crate::host::cli::update::open_app_update(data_root, installation)
        .map_err(|code| BtccError::relayed(code.to_string(), "App update service is unavailable"))
}

fn app_error(error: GatewayApplicationError) -> BtccError {
    match error {
        GatewayApplicationError::Public { code, message, .. } => BtccError::relayed(code, message),
        GatewayApplicationError::Internal { .. } => {
            BtccError::relayed("app_application_failed", "App application is unavailable")
        }
    }
}

async fn start_application(
    application: &butler_gateway::gateway::AppApplication,
) -> Result<(), butler_gateway::gateway::GatewayApplicationError> {
    // Interruption transcripts precede FIFO lease recovery, so their exact
    // old claims remain valid until terminal projection settles them.
    application.drain_projection().await?;
    application.start_dispatch().await
}

impl AppServerOwners {
    fn start_setup(
        &self,
        runtime: &AgentRuntime,
        settings: Arc<AppSettingsFactsAdapter>,
        installation: &ResolvedInstallation,
        data_root: &std::path::Path,
    ) -> AppSetup {
        AppSetup::start(AppSetupParts {
            configuration: runtime.models.configuration.clone(),
            settings,
            installation: installation.clone(),
            data_root: data_root.to_path_buf(),
            executor: self.receipt.clone(),
            acquisition: runtime.memory_acquisition.clone(),
        })
    }
}
