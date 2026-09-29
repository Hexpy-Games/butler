//! Native App HTTP and durable file-queue entrypoint with one shutdown sequence.

use std::sync::Arc;

use serde_json::json;

use butler_gateway::gateway::TranscriptWriter;
use butler_models::models::ModelConfigurationClock;
use butler_runtime::operations::ServiceReadiness;
use butler_turn::btcc::BtccError;

use crate::host::app::gateway_lifecycle::{
    ActiveAppEndpoint, AppGatewayLifecycle, GatewayControlServer, local_auth_unconfigured,
};
use crate::host::service::foreground_lease::ForegroundLease;
use crate::host::service::ingress::IngressDispatcher;
use crate::host::service::restart_handoff::RestartHandoff;
mod maintenance;
mod poll;
mod stop_signal;
mod support;
use crate::host::service::delivery::AppDelivery;
use crate::host::{
    AgentRuntime, ProcessEnvironment, ProgressPublisher, ResolvedInstallation, RuntimePaths,
    ServiceConfiguration, SystemIdentity, require_model_ref,
};
use poll::{PollOwners, PollShutdown, poll_service};
use stop_signal::{START_CANCELLED, StopSignal};
use support::{close_runtime, failure, holds_foreground_lease, io, process_locale};

/// The product binary's sole entrypoint; domains remain crate-private.
///
/// Returns the bound session once the service stops on request (`None` when
/// the stop ended startup first). An exit nobody asked for is an error, so the
/// process exits non-zero and its supervisor replaces it.
pub(crate) async fn run_native_service(
    installation: ResolvedInstallation,
) -> Result<Option<String>, crate::host::HostError> {
    run(installation, None, None, ServiceLogMode::desktop())
        .await
        .map_err(|error| format!("{}: {}", error.code(), error.message()))
        .map_err(crate::host::HostError::from)
}

pub(crate) async fn run_native_service_with_options(
    installation: ResolvedInstallation,
    explicit_data: Option<String>,
    detached: bool,
    quiet: bool,
) -> Result<Option<String>, crate::host::HostError> {
    let foreground_lease = if detached { Some(false) } else { None };
    run(
        installation,
        explicit_data.as_deref(),
        foreground_lease,
        ServiceLogMode::cli(quiet),
    )
    .await
    .map_err(|error| format!("{}: {}", error.code(), error.message()))
    .map_err(crate::host::HostError::from)
}

#[derive(Clone, Copy)]
struct ServiceLogMode {
    stderr: bool,
    quiet: bool,
}

impl ServiceLogMode {
    fn desktop() -> Self {
        Self {
            stderr: false,
            quiet: false,
        }
    }

    fn cli(quiet: bool) -> Self {
        Self {
            stderr: true,
            quiet,
        }
    }

    fn write(self, message: &str) {
        if !self.quiet {
            self.problem(message);
        }
    }

    /// Writes even in quiet mode: a problem the operator must see.
    fn problem(self, message: &str) {
        if self.stderr {
            eprintln!("{message}");
        } else {
            println!("{message}");
        }
    }
}

async fn run(
    installation: ResolvedInstallation,
    explicit_data: Option<&str>,
    foreground_lease: Option<bool>,
    logs: ServiceLogMode,
) -> Result<Option<String>, BtccError> {
    // Before the instance record exists: a stop can only target this process
    // once the record is published, and it must never find the signal's
    // default action (death by SIGTERM) in place.
    let stop = StopSignal::listen().map_err(io)?;
    let result =
        run_until_stopped(installation, explicit_data, foreground_lease, logs, &stop).await;
    stop.settle(result, |line| logs.problem(line))
}

async fn run_until_stopped(
    installation: ResolvedInstallation,
    explicit_data: Option<&str>,
    foreground_lease: Option<bool>,
    logs: ServiceLogMode,
    stop: &StopSignal,
) -> Result<String, BtccError> {
    let user_home = butler_platform::user_dirs::home_dir()
        .filter(|home| !home.as_os_str().is_empty())
        .ok_or_else(|| failure("native_home_unavailable", "User home is unavailable"))?;
    let config = ServiceConfiguration::capture(explicit_data, &user_home, &installation)?;
    report_credential_errors(&config, logs);
    let executable = std::env::current_exe().map_err(io)?;
    let mut instance = crate::host::service::instance::InstanceGuard::acquire(
        &config.data_root,
        &executable,
        &config.installation,
        holds_foreground_lease(foreground_lease),
    )
    .map_err(|message| {
        failure("native_service_instance_unavailable", message.to_string()).with_source(message)
    })?;
    stop.attach(config.data_root.clone(), instance.nonce());
    repair_cli_launcher(&config, logs);
    let os_release = butler_platform::instance::os_release().map_err(io)?;
    let environment = ProcessEnvironment::capture(&config.data_root, &user_home, &os_release);
    let worker_profiles = Arc::new(crate::host::AppWorkerProfileReader::new(
        &config.app,
        config.app.gateway_config().local_auth,
    )?);
    let app_endpoint = Arc::new(ActiveAppEndpoint::new());
    let runtime = Arc::new(
        AgentRuntime::open(
            RuntimePaths {
                data_root: config.data_root.clone(),
                installation_root: config.installation.root().to_path_buf(),
                executable_path: config.installation.executable().to_path_buf(),
                resource_root: config.installation.resources().to_path_buf(),
                workspace_root: config.data_root.clone(),
            },
            config.app.db_path.clone(),
            config.installation.clone(),
            environment,
            &process_locale(),
            worker_profiles,
            app_endpoint.clone(),
        )
        .await?,
    );
    let writer = match TranscriptWriter::new(config.data_root.clone(), Arc::new(SystemIdentity)) {
        Ok(writer) => Arc::new(writer),
        Err(error) => {
            let _ = close_runtime(runtime).await;
            return Err(io(error));
        }
    };
    let result = serve(
        runtime.clone(),
        app_endpoint,
        &config,
        writer.clone(),
        &mut instance,
        logs,
        stop,
    )
    .await;
    close_after_serve(runtime, &writer, result).await
}

/// Admission and dispatcher tasks have ended before BTCC closes its services.
/// The transcript lane outlives all producers and is joined last.
async fn close_after_serve(
    runtime: Arc<AgentRuntime>,
    writer: &TranscriptWriter,
    result: Result<String, BtccError>,
) -> Result<String, BtccError> {
    let runtime_close = close_runtime(runtime).await;
    let transcript_close = writer
        .close()
        .await
        .map_err(|e| failure(e.code(), e.message()));
    match result {
        Err(error) => Err(error),
        Ok(session) => runtime_close.and(transcript_close).map(|()| session),
    }
}

/// Without its token the App gateway refuses every client
/// (`local_auth_unconfigured`, fail closed); the log says which file failed
/// and why.
fn report_credential_errors(config: &ServiceConfiguration, logs: ServiceLogMode) {
    for error in config.app.credential_errors() {
        logs.problem(&format!(
            "[native-app] local auth unavailable {}",
            error.diagnostic()
        ));
    }
}

/// Starts the App gateway and logs its outcome: `ready` only when it serves
/// clients. Without its token it stays up refusing every client
/// (`local_auth_unconfigured`), which is logged as a problem, not as ready.
async fn start_app_gateway(
    gateway: &AppGatewayLifecycle,
    config: &ServiceConfiguration,
    endpoint: &ActiveAppEndpoint,
    logs: ServiceLogMode,
) {
    if let Err(error) = gateway.start_initial(&config.app).await {
        logs.write(&format!("[native-app] unavailable code={}", error.code()));
    } else if let Some(active) = endpoint.snapshot() {
        if local_auth_unconfigured(&active.local_auth) {
            logs.problem(&format!(
                "[native-app] refusing clients address={} code=local_auth_unconfigured",
                active.base_url
            ));
        } else {
            logs.write(&format!("[native-app] ready address={}", active.base_url));
        }
    }
}

/// Self-repair of the user's `butler` command; never blocks the service.
fn repair_cli_launcher(config: &ServiceConfiguration, logs: ServiceLogMode) {
    use crate::host::service::cli_launcher::{LauncherRepair, repair};
    match repair(&config.data_root, &config.installation) {
        Ok(LauncherRepair::Absent | LauncherRepair::NotInstalled | LauncherRepair::Current) => {}
        Ok(LauncherRepair::Updated) => logs.write("[native-cli] launcher updated"),
        Ok(LauncherRepair::ReplacedStale) => logs.write("[native-cli] stale launcher replaced"),
        Ok(LauncherRepair::Foreign) => {
            logs.write("[native-cli] bin/butler is not a Butler launcher; left unchanged");
        }
        Err(error) => logs.write(&format!(
            "[native-cli] launcher repair failed kind={:?}",
            error.kind()
        )),
    }
}

async fn serve(
    runtime: Arc<AgentRuntime>,
    app_endpoint: Arc<ActiveAppEndpoint>,
    config: &ServiceConfiguration,
    writer: Arc<TranscriptWriter>,
    instance: &mut crate::host::service::instance::InstanceGuard,
    logs: ServiceLogMode,
    stop: &StopSignal,
) -> Result<String, BtccError> {
    let bootstrap = config
        .bootstrap_butler_session(&runtime.bindings, &runtime.collation)
        .await?;
    let binding = bootstrap.binding;
    if bootstrap.newly_registered {
        writer
            .append_lifecycle(
                binding.session_id.clone(),
                "butler".into(),
                "active".into(),
                Some("native-butler-bootstrap".into()),
                json!({"projectId":binding.project_id,"workspacePath":binding.workspace_path}),
            )
            .await
            .map_err(|e| failure(e.code(), e.message()))?;
    }
    config.persist_session_pointer(&binding.session_id)?;
    let model = require_model_ref(&binding)?;
    let progress = Arc::new(ProgressPublisher::new(
        runtime.progress.clone(),
        writer.clone(),
    ));
    let queue = runtime.inbound_queue.clone();
    let restart_handoff = Arc::new(RestartHandoff::new(
        runtime.restart_tool_journal.clone(),
        runtime.restart_effect_journal.clone(),
        config.installation.clone(),
        config.data_root.clone(),
        instance.restart_identity(),
    ));
    queue
        .recover_runtime_interruptions()
        .map_err(|e| failure(e.code(), e.message()))?;
    let dispatcher = IngressDispatcher::new(
        queue.clone(),
        runtime.btcc.clone(),
        runtime.authority.clone(),
        runtime.bindings.clone(),
        config.data_root.clone(),
        config.data_root.clone(),
        Arc::new(AppDelivery::new(writer, progress.clone())),
        runtime.subsessions.clone(),
        restart_handoff,
    );
    let parent_client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(io)?;
    let foreground_lease = if instance.app_supervised() {
        Some(ForegroundLease::capture().map_err(io)?)
    } else {
        None
    };
    let now_ms = SystemIdentity.now_epoch_millis();
    ServiceReadiness::startup_grace(&config.data_root, now_ms).map_err(io)?;
    let readiness = Arc::new(
        ServiceReadiness::publish(&config.data_root, &SystemIdentity.now_iso(), now_ms)
            .map_err(io)?,
    );
    let gateway = Arc::new(AppGatewayLifecycle::new(
        runtime.clone(),
        config,
        queue.clone(),
        readiness.clone(),
        app_endpoint.clone(),
        instance.nonce().to_owned(),
    ));
    start_app_gateway(&gateway, config, &app_endpoint, logs).await;
    let control = match GatewayControlServer::bind(
        config.data_root.clone(),
        config.installation.clone(),
        instance.nonce().to_owned(),
        gateway.clone(),
        runtime.restart_effect_journal.clone(),
    )
    .await
    {
        Ok(control) => control,
        Err(message) => {
            let _ = gateway.close().await;
            let _ = dispatcher.close().await;
            drop(readiness);
            return Err(failure("gateway_control_unavailable", message.to_string()));
        }
    };
    if let Err(message) =
        instance.publish_control(control.endpoint().to_owned(), control.token().to_owned())
    {
        let _ = control.close().await;
        let _ = gateway.close().await;
        let _ = dispatcher.close().await;
        drop(readiness);
        return Err(failure(
            "native_service_instance_state_unavailable",
            message.to_string(),
        ));
    }
    logs.write(&format!("[native-butler] ready model={model}"));
    let startup = async {
        runtime.context_maintenance.start();
        runtime.subsessions.recover_dispatches().await?;
        mark_ready(instance, &app_endpoint, stop)
    }
    .await;
    match startup {
        Ok(()) => {}
        Err(error) => {
            let _ = control.close().await;
            let _ = gateway.close().await;
            let _ = dispatcher.close().await;
            drop(readiness);
            return Err(error);
        }
    }
    let subsessions = runtime.subsessions.repository();
    let result = poll_service(
        PollOwners {
            dispatcher: &dispatcher,
            queue: queue.clone(),
            progress: progress.clone(),
            config,
            subsessions: &subsessions,
            parent_client: &parent_client,
            app_endpoint: &app_endpoint,
            logs,
        },
        PollShutdown {
            stop,
            foreground_lease,
        },
    )
    .await;
    // The private control plane stops admitting lifecycle requests before App
    // owners drain; BTCC, inbound dispatch, and transcript publication remain live.
    let control_close = control.close().await.map_err(|message| {
        failure("gateway_control_close_failed", message.to_string()).with_source(message)
    });
    let app_close = gateway.close().await;
    let close = dispatcher
        .close()
        .await
        .map_err(|e| failure(e.code, e.message));
    let publication = progress.reconcile().await.map(|_| ());
    drop(readiness);
    result
        .and(control_close)
        .and(app_close)
        .and(close)
        .and(publication)
        .map(|()| binding.session_id)
}

/// Publishes the ready record, unless a stop was requested during startup:
/// a process asked to stop never becomes ready (and never clears the stop
/// intent the next instance clears).
fn mark_ready(
    instance: &mut crate::host::service::instance::InstanceGuard,
    app_endpoint: &ActiveAppEndpoint,
    stop: &StopSignal,
) -> Result<(), BtccError> {
    if stop.requested() {
        return Err(StopSignal::cancelled_startup());
    }
    let active = app_endpoint.snapshot();
    instance
        .mark_ready(
            active.is_some(),
            active.as_ref().map(|active| active.base_url.clone()),
            active
                .as_ref()
                .is_some_and(|active| active.local_auth.required),
            SystemIdentity.now_iso(),
        )
        .map_err(|message| {
            // A controller marked the record `stopping` first.
            let code = if message.message() == START_CANCELLED {
                START_CANCELLED
            } else {
                "native_service_instance_state_unavailable"
            };
            failure(code, message.to_string()).with_source(message)
        })
}
