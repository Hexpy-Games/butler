//! Native App HTTP and durable file-queue entrypoint with one shutdown sequence.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use tokio::signal::unix::{Signal, SignalKind, signal};
use tokio::{sync::oneshot, task::JoinSet, time::MissedTickBehavior};

use crate::btcc::BtccError;
use crate::gateway::NativeTranscriptWriter;
use crate::models::ModelConfigurationClock;
use crate::operations::ServiceReadiness;

use super::foreground_lease::ForegroundLease;
use super::gateway_lifecycle::{
    GatewayControlServer, NativeActiveAppEndpoint, NativeAppGatewayLifecycle,
};
use super::native_ingress::NativeIngressDispatcher;
use super::restart_handoff::NativeRestartHandoff;
mod support;
use super::service_delivery::NativeAppDelivery;
use super::{
    NativeAgentRuntime, NativeProcessEnvironment, NativeProgressPublisher, NativeRuntimePaths,
    NativeServiceConfiguration, ResolvedInstallation, SystemIdentity, require_model_ref,
};
use support::{close_runtime, deliver_parent_results, failure, io, process_locale};

const INBOUND_QUEUE_FALLBACK_POLL: Duration = Duration::from_millis(500);
const SERVICE_MAINTENANCE_INTERVAL: Duration = Duration::from_millis(500);

/// The product binary's sole entrypoint; domains remain crate-private.
pub async fn run_native_service(installation: ResolvedInstallation) -> Result<String, String> {
    run(installation, None, None, ServiceLogMode::desktop())
        .await
        .map_err(|error| format!("{}: {}", error.code, error.message))
}

pub(crate) async fn run_native_service_with_options(
    installation: ResolvedInstallation,
    explicit_data: Option<String>,
    detached: bool,
    quiet: bool,
) -> Result<String, String> {
    let foreground_lease = if detached { Some(false) } else { None };
    run(
        installation,
        explicit_data.as_deref(),
        foreground_lease,
        ServiceLogMode::cli(quiet),
    )
    .await
    .map_err(|error| format!("{}: {}", error.code, error.message))
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

    fn write(self, message: String) {
        if self.quiet {
            return;
        }
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
) -> Result<String, BtccError> {
    let user_home = std::env::var_os("HOME")
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| failure("native_home_unavailable", "User home is unavailable"))?;
    let config = NativeServiceConfiguration::capture(explicit_data, &user_home, &installation)?;
    let executable = std::env::current_exe().map_err(io)?;
    let mut instance = super::service_instance::InstanceGuard::acquire(
        &config.data_root,
        &executable,
        &config.installation,
    )
    .map_err(|message| failure("native_service_instance_unavailable", message))?;
    let os = nix::sys::utsname::uname().map_err(io)?;
    let environment = NativeProcessEnvironment::capture(
        &config.data_root,
        &user_home,
        &os.release().to_string_lossy(),
    );
    let worker_profiles = Arc::new(super::NativeWorkerProfileReader::new(
        &config.app,
        config.app.gateway_config().local_auth,
    )?);
    let app_endpoint = Arc::new(NativeActiveAppEndpoint::new());
    let runtime = Arc::new(
        NativeAgentRuntime::open(
            NativeRuntimePaths {
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
    let writer =
        match NativeTranscriptWriter::new(config.data_root.clone(), Arc::new(SystemIdentity)) {
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
        foreground_lease,
        logs,
    )
    .await;
    // Admission and dispatcher tasks have ended before BTCC closes its services.
    // The transcript lane outlives all producers and is joined last.
    let runtime_close = close_runtime(runtime).await;
    let transcript_close = writer.close().await.map_err(|e| failure(e.code, e.message));
    match result {
        Err(error) => Err(error),
        Ok(session) => runtime_close.and(transcript_close).map(|()| session),
    }
}

async fn serve(
    runtime: Arc<NativeAgentRuntime>,
    app_endpoint: Arc<NativeActiveAppEndpoint>,
    config: &NativeServiceConfiguration,
    writer: Arc<NativeTranscriptWriter>,
    instance: &mut super::service_instance::InstanceGuard,
    foreground_lease_override: Option<bool>,
    logs: ServiceLogMode,
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
            .map_err(|e| failure(e.code, e.message))?;
    }
    config.persist_session_pointer(&binding.session_id)?;
    let model = require_model_ref(&binding)?;
    let progress = Arc::new(NativeProgressPublisher::new(
        runtime.progress.clone(),
        writer.clone(),
    ));
    let queue = runtime.inbound_queue.clone();
    let restart_handoff = Arc::new(NativeRestartHandoff::new(
        runtime.restart_tool_journal.clone(),
        runtime.restart_effect_journal.clone(),
        config.installation.clone(),
        config.data_root.clone(),
        instance.restart_identity(),
    ));
    queue
        .recover_runtime_interruptions()
        .map_err(|e| failure(e.code, e.message))?;
    let dispatcher = NativeIngressDispatcher::new(
        queue.clone(),
        runtime.btcc.clone(),
        runtime.authority.clone(),
        runtime.bindings.clone(),
        config.data_root.clone(),
        config.data_root.clone(),
        Arc::new(NativeAppDelivery::new(writer)),
        runtime.subsessions.clone(),
        restart_handoff,
    );
    let interrupt = signal(SignalKind::interrupt()).map_err(io)?;
    let terminate = signal(SignalKind::terminate()).map_err(io)?;
    let parent_client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(io)?;
    let use_foreground_lease = foreground_lease_override
        .unwrap_or_else(|| std::env::var("BUTLER_APP_FOREGROUND_LEASE").as_deref() == Ok("1"));
    let foreground_lease = if use_foreground_lease {
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
    let gateway = Arc::new(NativeAppGatewayLifecycle::new(
        runtime.clone(),
        config,
        queue.clone(),
        readiness.clone(),
        app_endpoint.clone(),
        instance.nonce().to_owned(),
    ));
    if let Err(error) = gateway.start_initial(&config.app).await {
        logs.write(format!("[native-app] unavailable code={}", error.code));
    } else if let Some(active) = app_endpoint.snapshot() {
        logs.write(format!("[native-app] ready address={}", active.base_url));
    }
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
            return Err(failure("gateway_control_unavailable", message));
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
            message,
        ));
    }
    logs.write(format!("[native-butler] ready model={model}"));
    let startup = async {
        runtime.context_maintenance.start();
        runtime.subsessions.recover_dispatches().await?;
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
            .map_err(|message| failure("native_service_instance_state_unavailable", message))?;
        Ok::<_, BtccError>(())
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
            interrupt,
            terminate,
            foreground_lease,
        },
    )
    .await;
    // The private control plane stops admitting lifecycle requests before App
    // owners drain; BTCC, inbound dispatch, and transcript publication remain live.
    let control_close = control
        .close()
        .await
        .map_err(|message| failure("gateway_control_close_failed", message));
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

struct PollOwners<'a> {
    dispatcher: &'a NativeIngressDispatcher,
    queue: Arc<crate::gateway::NativeInboundQueue>,
    progress: Arc<NativeProgressPublisher>,
    config: &'a NativeServiceConfiguration,
    subsessions: &'a crate::btcc::SqliteSubsessionRepository,
    parent_client: &'a reqwest::Client,
    app_endpoint: &'a NativeActiveAppEndpoint,
    logs: ServiceLogMode,
}

struct PollShutdown {
    interrupt: Signal,
    terminate: Signal,
    foreground_lease: Option<ForegroundLease>,
}

async fn poll_service(owners: PollOwners<'_>, shutdown: PollShutdown) -> Result<(), BtccError> {
    let PollOwners {
        dispatcher,
        queue,
        progress,
        config,
        subsessions,
        parent_client,
        app_endpoint,
        logs,
    } = owners;
    let PollShutdown {
        mut interrupt,
        mut terminate,
        foreground_lease,
    } = shutdown;
    let shutdown_flag = config.data_root.join("locks/butler-shutdown");
    let (stop_maintenance, maintenance_stop) = oneshot::channel();
    let mut maintenance = JoinSet::new();
    maintenance.spawn(run_service_maintenance(
        progress,
        parent_client.clone(),
        subsessions.clone(),
        app_endpoint.clone(),
        maintenance_stop,
    ));
    let mut fallback_poll = tokio::time::interval_at(
        tokio::time::Instant::now() + INBOUND_QUEUE_FALLBACK_POLL,
        INBOUND_QUEUE_FALLBACK_POLL,
    );
    fallback_poll.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let result = loop {
        if shutdown_flag.exists() {
            break Ok(());
        }
        let summary = match dispatcher.poll().await {
            Ok(summary) => summary,
            Err(error) => break Err(failure(error.code, error.message)),
        };
        if summary.claimed + summary.handled + summary.failed + summary.interrupted > 0 {
            logs.write(format!(
                "[inbound-queue] claimed={} handled={} delivered={} failed={} interrupted={}",
                summary.claimed,
                summary.handled,
                summary.delivered,
                summary.failed,
                summary.interrupted
            ));
        }
        if summary.interrupted > 0 {
            break Ok(());
        }
        tokio::select! {
            _ = interrupt.recv() => break Ok(()),
            _ = terminate.recv() => break Ok(()),
            lease = wait_for_foreground_close(foreground_lease.as_ref()), if foreground_lease.is_some() => {
                break lease.map_err(io);
            },
            joined = maintenance.join_next() => break unexpected_maintenance_exit(joined),
            _ = queue.wait_for_enqueue() => {},
            _ = fallback_poll.tick() => {},
        }
    };
    let _ = stop_maintenance.send(());
    let maintenance_result = match maintenance.join_next().await {
        Some(joined) => maintenance_join_result(joined),
        None => Ok(()),
    };
    result.and(maintenance_result)
}

async fn run_service_maintenance(
    progress: Arc<NativeProgressPublisher>,
    parent_client: reqwest::Client,
    subsessions: crate::btcc::SqliteSubsessionRepository,
    app_endpoint: NativeActiveAppEndpoint,
    mut stop: oneshot::Receiver<()>,
) -> Result<(), BtccError> {
    let mut interval = tokio::time::interval(SERVICE_MAINTENANCE_INTERVAL);
    interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            biased;
            _ = &mut stop => return Ok(()),
            _ = interval.tick() => {},
        }
        let pass = async {
            progress.reconcile().await?;
            if let Some(active) = app_endpoint.snapshot() {
                deliver_parent_results(
                    &parent_client,
                    &subsessions,
                    &active.base_url,
                    &active.local_auth,
                )
                .await?;
            }
            Ok::<(), BtccError>(())
        };
        tokio::select! {
            biased;
            _ = &mut stop => return Ok(()),
            result = pass => result?,
        }
    }
}

fn maintenance_join_result(
    joined: Result<Result<(), BtccError>, tokio::task::JoinError>,
) -> Result<(), BtccError> {
    match joined {
        Ok(result) => result,
        Err(_) => Err(failure(
            "native_service_maintenance_failed",
            "Native service maintenance task failed",
        )),
    }
}

fn unexpected_maintenance_exit(
    joined: Option<Result<Result<(), BtccError>, tokio::task::JoinError>>,
) -> Result<(), BtccError> {
    match joined {
        Some(Ok(Err(error))) => Err(error),
        Some(Err(_)) => Err(failure(
            "native_service_maintenance_failed",
            "Native service maintenance task failed",
        )),
        Some(Ok(Ok(()))) | None => Err(failure(
            "native_service_maintenance_stopped",
            "Native service maintenance stopped unexpectedly",
        )),
    }
}

async fn wait_for_foreground_close(lease: Option<&ForegroundLease>) -> Result<(), String> {
    match lease {
        Some(lease) => lease.closed().await,
        None => std::future::pending().await,
    }
}
