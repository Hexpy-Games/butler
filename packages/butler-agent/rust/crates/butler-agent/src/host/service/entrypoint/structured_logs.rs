//! The service owns the logging thread for its complete serving lifetime.
use super::*;
use crate::host::ServiceConfiguration;

pub(super) async fn start(config: &ServiceConfiguration, port: u16) -> Result<Guard, BtccError> {
    let root = config.data_root.clone();
    let log = tokio::task::spawn_blocking(move || {
        let config = butler_gateway::gateway::startup_log_config(
            &root.join("app-server/butler-client.sqlite"),
        )?;
        let log = butler_log::Logger::open(&root, config)?;
        butler_log::install(log.clone())?;
        Ok::<_, std::io::Error>(log)
    })
    .await
    .map_err(super::io)?
    .map_err(super::io)?;
    let mut row = butler_log::Record::new("INFO", "lifecycle", "agent.startup", "Agent starting");
    row.attrs = serde_json::json!({"version":super::super::diagnostics::version(&config.installation),"port":port,"data_dir":"."});
    log.record(row).map_err(super::io)?;
    Ok(Guard(Some(log)))
}
pub(super) struct Guard(Option<butler_log::Logger>);
impl Guard {
    pub(super) async fn close(mut self) -> Result<(), BtccError> {
        if let Some(log) = self.0.take() {
            tokio::task::spawn_blocking(move || finish(&log))
                .await
                .map_err(super::io)?
                .map_err(super::io)?;
        }
        Ok(())
    }
}
fn finish(log: &butler_log::Logger) -> std::io::Result<()> {
    log.record(butler_log::Record::new(
        "INFO",
        "lifecycle",
        "agent.shutdown",
        "Agent stopped",
    ))?;
    log.shutdown()
}
impl Drop for Guard {
    fn drop(&mut self) {
        if let Some(log) = self.0.take() {
            tokio::task::spawn_blocking(move || finish(&log));
        }
    }
}

pub(super) async fn run_until_stopped(
    installation: ResolvedInstallation,
    explicit_data: Option<&str>,
    foreground_lease: Option<bool>,
    logs: ServiceLogMode,
    stop: &StopSignal,
    readiness: (
        tokio::sync::oneshot::Sender<()>,
        crate::host::runtime::startup_trace::CorrectionSender,
    ),
) -> Result<String, BtccError> {
    let (ready, correction) = readiness;
    let user_home = butler_platform::user_dirs::home_dir()
        .filter(|home| !home.as_os_str().is_empty())
        .ok_or_else(|| failure("native_home_unavailable", "User home is unavailable"))?;
    let journal_seen =
        crate::host::service::data_reset::recover(explicit_data, &user_home, &installation).await?;
    let mut config =
        support::capture_configuration(explicit_data, &user_home, &installation).await?;
    let listener = if config.app.enabled {
        Some(crate::host::AppServer::bind(&config.app.host, config.app.port).await?)
    } else {
        None
    };
    let executable = butler_platform::process_names::current_exe().map_err(io)?;
    let mut instance = support::acquire_instance(
        &config,
        executable,
        holds_foreground_lease(foreground_lease),
    )
    .await?;
    crate::host::service::data_reset::initialize_owned(&config, &user_home, journal_seen).await?;
    config = support::initialize_credentials(config).await?;
    report_credential_errors(&config, logs);
    let port = listener
        .as_ref()
        .and_then(|listener| listener.local_addr().ok())
        .map_or(config.app.port, |address| address.port());
    let structured_logs = start(&config, port).await?;
    let result = serve_initialized(
        &config,
        &user_home,
        logs,
        stop,
        (listener, ready, correction),
        &mut instance,
    )
    .await;
    let closed = crate::host::service::shutdown_trace::measure(
        "structured_logs_close",
        structured_logs.close(),
    )
    .await;
    // serve_initialized has joined App DB/artifact jobs, native dispatcher,
    // BTCC/conversation/binding stores, memory/cognition, developer capture and
    // transcript writer. Browser owners are joined by the HTTP listener;
    // metrics have no independent writer. A close error forbids reset apply.
    let reset = if result.is_ok() && closed.is_ok() {
        crate::host::service::shutdown_trace::measure(
            "data_reset_apply",
            crate::host::service::data_reset::finish(config.data_root.clone()),
        )
        .await
    } else {
        Ok(())
    };
    tokio::task::spawn_blocking(move || instance.release())
        .await
        .map_err(|error| failure("native_service_instance_release_failed", error.to_string()))?;
    result.and_then(|session| closed.and(reset).map(|()| session))
}

async fn serve_initialized(
    config: &ServiceConfiguration,
    user_home: &std::path::Path,
    logs: ServiceLogMode,
    stop: &StopSignal,
    (listener, ready, correction): (
        Option<tokio::net::TcpListener>,
        tokio::sync::oneshot::Sender<()>,
        crate::host::runtime::startup_trace::CorrectionSender,
    ),
    instance: &mut crate::host::service::instance::InstanceGuard,
) -> Result<String, BtccError> {
    stop.attach(
        config.data_root.clone(),
        instance.nonce(),
        config.installation.clone(),
    );
    stop.check_startup()?;
    repair_cli_launcher(config, logs);
    let app_endpoint = Arc::new(ActiveAppEndpoint::new());
    let runtime = support::open_runtime(
        config,
        user_home,
        instance.unclean_previous_exit(),
        stop,
        correction,
        &app_endpoint,
    )
    .await?;
    if stop.requested() {
        let _ = close_runtime(runtime).await;
        return Err(StopSignal::cancelled_startup());
    }
    let (runtime, writer) = support::open_writer(runtime, config.data_root.clone()).await?;
    stop.attach_writer(writer.clone());
    let result = serve(
        runtime.clone(),
        (app_endpoint, listener, ready),
        config,
        writer.clone(),
        instance,
        logs,
        stop,
    )
    .await;
    close_after_serve(runtime, &writer, result).await
}
