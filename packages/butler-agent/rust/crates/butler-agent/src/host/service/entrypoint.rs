//! Native App HTTP and durable file-queue entrypoint with one shutdown sequence.

use std::sync::Arc;

use butler_gateway::gateway::TranscriptWriter;
use butler_models::models::ModelConfigurationClock;
use butler_runtime::operations::ServiceReadiness;
use butler_turn::btcc::BtccError;

use crate::host::app::gateway_lifecycle::{
    ActiveAppEndpoint, AppGatewayLifecycle, ControlOwners, GatewayControlServer,
    local_auth_unconfigured,
};
use crate::host::service::foreground_lease::ForegroundLease;
use crate::host::service::ingress::IngressDispatcher;
mod admission;
mod maintenance;
mod poll;
mod startup;
mod stop_signal;
pub(crate) use startup::STARTUP_TIMEOUT;
mod support;
use crate::host::{
    AgentRuntime, ProcessEnvironment, ResolvedInstallation, RuntimePaths, ServiceConfiguration,
    SystemIdentity,
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
    let (ready, initialized) = tokio::sync::oneshot::channel();
    let service = Box::pin(run_until_stopped(
        installation,
        explicit_data,
        foreground_lease,
        logs,
        &stop,
        ready,
    ));
    let result = startup::until_ready(service, initialized, &stop).await;
    stop.settle(result, |line| logs.problem(line))
}

async fn run_until_stopped(
    installation: ResolvedInstallation,
    explicit_data: Option<&str>,
    foreground_lease: Option<bool>,
    logs: ServiceLogMode,
    stop: &StopSignal,
    ready: tokio::sync::oneshot::Sender<()>,
) -> Result<String, BtccError> {
    let user_home = butler_platform::user_dirs::home_dir()
        .filter(|home| !home.as_os_str().is_empty())
        .ok_or_else(|| failure("native_home_unavailable", "User home is unavailable"))?;
    let mut config = ServiceConfiguration::capture(explicit_data, &user_home, &installation)?;
    let listener = if config.app.enabled {
        Some(crate::host::AppServer::bind(&config.app.host, config.app.port).await?)
    } else {
        None
    };
    config.initialize_app_credentials();
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
                unclean_previous_exit: instance.unclean_previous_exit(),
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
        (app_endpoint, listener, ready),
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
    listener: Option<tokio::net::TcpListener>,
) -> Result<(), BtccError> {
    gateway.start_initial(&config.app, listener).await?;
    if let Some(active) = endpoint.snapshot() {
        if local_auth_unconfigured(&active.local_auth) {
            logs.problem(&format!(
                "[native-app] refusing clients address={} code=local_auth_unconfigured",
                active.base_url
            ));
        } else {
            logs.write(&format!("[native-app] ready address={}", active.base_url));
        }
    }
    Ok(())
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
    app: (
        Arc<ActiveAppEndpoint>,
        Option<tokio::net::TcpListener>,
        tokio::sync::oneshot::Sender<()>,
    ),
    config: &ServiceConfiguration,
    writer: Arc<TranscriptWriter>,
    instance: &mut crate::host::service::instance::InstanceGuard,
    logs: ServiceLogMode,
    stop: &StopSignal,
) -> Result<String, BtccError> {
    let (app_endpoint, listener, ready) = app;
    let admission::Admission {
        session_id,
        model,
        progress,
        queue,
        dispatcher,
    } = admission::prepare(&runtime, config, writer, instance).await?;

    let parent_client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(io)?;
    let foreground_lease = capture_foreground_lease(instance)?;
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
    if let Err(error) = start_app_gateway(&gateway, config, &app_endpoint, logs, listener).await {
        let _ = gateway.close().await;
        let _ = dispatcher.close().await;
        return Err(error);
    }
    let control = start_control(&gateway, &runtime, config, instance, &dispatcher, stop).await?;
    logs.write(&format!("[native-butler] ready model={model}"));
    if let Err(error) = start_runtime(&runtime, instance, &app_endpoint, stop).await {
        let _ = control.close().await;
        let _ = gateway.close().await;
        let _ = dispatcher.close().await;
        return Err(error);
    }
    let _ = ready.send(());
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
    let close = close_serving(control, &gateway, &dispatcher, &progress).await;
    drop(readiness);
    result.and(close).map(|()| session_id)
}

/// Recover durable dispatches before publishing the ready instance.
async fn start_runtime(
    runtime: &AgentRuntime,
    instance: &mut crate::host::service::instance::InstanceGuard,
    app_endpoint: &ActiveAppEndpoint,
    stop: &StopSignal,
) -> Result<(), BtccError> {
    runtime.context_maintenance.start();
    runtime.subsessions.recover_dispatches().await?;
    mark_ready(instance, app_endpoint, runtime, stop).await
}

fn capture_foreground_lease(
    instance: &crate::host::service::instance::InstanceGuard,
) -> Result<Option<ForegroundLease>, BtccError> {
    if instance.app_supervised() {
        ForegroundLease::capture().map(Some).map_err(io)
    } else {
        Ok(None)
    }
}

/// Stops lifecycle admission, then drains App and inbound producers while
/// BTCC and transcript publication remain live.
async fn close_serving(
    control: GatewayControlServer,
    gateway: &AppGatewayLifecycle,
    dispatcher: &IngressDispatcher,
    progress: &crate::host::ProgressPublisher,
) -> Result<(), BtccError> {
    let control_close = control.close().await.map_err(|message| {
        failure("gateway_control_close_failed", message.to_string()).with_source(message)
    });
    let app_close = gateway.close().await;
    let close = dispatcher
        .close()
        .await
        .map_err(|e| failure(e.code, e.message));
    let publication = progress.reconcile().await.map(|_| ());
    control_close.and(app_close).and(close).and(publication)
}

/// Rolls back the App and dispatcher if the private control plane cannot start.
async fn start_control(
    gateway: &Arc<AppGatewayLifecycle>,
    runtime: &AgentRuntime,
    config: &ServiceConfiguration,
    instance: &mut crate::host::service::instance::InstanceGuard,
    dispatcher: &IngressDispatcher,
    stop: &StopSignal,
) -> Result<GatewayControlServer, BtccError> {
    let control = match GatewayControlServer::bind(
        config.data_root.clone(),
        config.installation.clone(),
        instance.nonce().to_owned(),
        control_owners(gateway, runtime, stop),
    )
    .await
    {
        Ok(control) => control,
        Err(message) => {
            let _ = gateway.close().await;
            let _ = dispatcher.close().await;
            return Err(failure("gateway_control_unavailable", message.to_string()));
        }
    };
    if let Err(message) =
        instance.publish_control(control.endpoint().to_owned(), control.token().to_owned())
    {
        let _ = control.close().await;
        let _ = gateway.close().await;
        let _ = dispatcher.close().await;
        return Err(failure(
            "native_service_instance_state_unavailable",
            message.to_string(),
        ));
    }
    Ok(control)
}

/// What the control endpoint serves: the App gateway lifecycle, the restart
/// journal and this service's stop (`service_stop`).
fn control_owners(
    gateway: &Arc<AppGatewayLifecycle>,
    runtime: &AgentRuntime,
    stop: &StopSignal,
) -> ControlOwners {
    let stop = stop.clone();
    ControlOwners {
        lifecycle: gateway.clone(),
        effects: runtime.restart_effect_journal.clone(),
        stop: Arc::new(move || stop.request_controlled()),
    }
}

/// Publishes the ready record, unless a stop was requested during startup:
/// a process asked to stop never becomes ready (and never clears the stop
/// intent the next instance clears).
async fn mark_ready(
    instance: &mut crate::host::service::instance::InstanceGuard,
    app_endpoint: &ActiveAppEndpoint,
    runtime: &AgentRuntime,
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
        })?;
    // A restart the service asked of its login job leaves no helper to
    // report: this instance coming up is the outcome.
    let _ = runtime
        .restart_effect_journal
        .finish_spawned_restart_handoffs()
        .await;
    Ok(())
}

async fn recover_inbound_queue(
    queue: Arc<butler_gateway::gateway::InboundQueue>,
) -> Result<(), BtccError> {
    tokio::task::spawn_blocking(move || queue.recover_runtime_interruptions())
        .await
        .map_err(|error| failure("inbound_queue_worker_failed", error.to_string()))?
        .map_err(|error| failure(error.code(), error.message()))?;
    Ok(())
}
