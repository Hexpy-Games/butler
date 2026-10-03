use std::sync::Arc;

use butler_models::models::ModelConfigurationClock;
use butler_turn::btcc::BtccError;

use crate::host::app::gateway_lifecycle::{AppGatewayLifecycle, GatewayControlServer};
use crate::host::service::ingress::IngressDispatcher;
use crate::host::service::shutdown_trace::measure;
use crate::host::{AgentRuntime, SystemIdentity};

pub(super) async fn deliver_parent_results(
    client: &reqwest::Client,
    repository: &butler_turn::btcc::SqliteSubsessionRepository,
    base: &str,
    auth: &butler_gateway::gateway::LocalAuthConfig,
) -> Result<(), BtccError> {
    for pending in repository
        .pending_parent_inputs()
        .await
        .map_err(|error| failure(error.code(), error.message()))?
    {
        if pending.route != butler_turn::btcc::ParentResultRoute::ButlerApp {
            continue;
        }
        let body = serde_json::to_string(&pending.input).map_err(|error| {
            failure("app_subsession_result_invalid", error.to_string()).with_source(error)
        })?;
        let mut request = client
            .post(format!("{base}/internal/subsession-result"))
            .header("content-type", "application/json")
            .body(body);
        if auth.required {
            let token = auth.token().ok_or_else(|| {
                failure(
                    "app_local_auth_unconfigured",
                    "App local auth is not configured",
                )
            })?;
            request = request.bearer_auth(token);
        }
        let Ok(response) = request.send().await else {
            continue;
        };
        if !response.status().is_success() {
            continue;
        }
        repository
            .mark_delivered(
                pending.result_id,
                ModelConfigurationClock::now_iso(&SystemIdentity),
            )
            .await
            .map_err(|error| failure(error.code(), error.message()))?;
    }
    Ok(())
}

pub(super) fn process_locale() -> String {
    let locale = ["LC_ALL", "LC_MESSAGES", "LANG"]
        .into_iter()
        .find_map(|key| std::env::var(key).ok())
        .unwrap_or_else(|| "C".into());
    let base = locale.split(['.', '@']).next().unwrap_or("C");
    if matches!(base, "" | "C" | "POSIX") {
        "en-US".into()
    } else {
        base.replace('_', "-")
    }
}

/// Whether this process holds the App's foreground lease on stdin: `service
/// run` decides by its `--detached` flag (`requested`), a start without a
/// command by the App's `BUTLER_APP_FOREGROUND_LEASE`.
pub(super) fn holds_foreground_lease(requested: Option<bool>) -> bool {
    requested.unwrap_or_else(|| std::env::var("BUTLER_APP_FOREGROUND_LEASE").as_deref() == Ok("1"))
}

pub(super) fn io(error: impl std::fmt::Display) -> BtccError {
    failure("native_service_io_failed", error.to_string())
}

pub(super) fn failure(code: impl Into<String>, message: impl Into<String>) -> BtccError {
    BtccError::relayed(code.into(), message)
}

pub(super) async fn close_runtime(runtime: Arc<AgentRuntime>) -> Result<(), BtccError> {
    match Arc::try_unwrap(runtime) {
        Ok(runtime) => runtime.close().await,
        Err(_) => Err(failure(
            "native_runtime_owner_leaked",
            "Native runtime has an owner after service shutdown",
        )),
    }
}

pub(super) async fn open_writer(
    runtime: Arc<AgentRuntime>,
    data_root: std::path::PathBuf,
) -> Result<
    (
        Arc<AgentRuntime>,
        Arc<butler_gateway::gateway::TranscriptWriter>,
    ),
    BtccError,
> {
    match butler_gateway::gateway::TranscriptWriter::new(data_root, Arc::new(SystemIdentity)) {
        Ok(writer) => Ok((runtime, Arc::new(writer))),
        Err(error) => {
            let _ = close_runtime(runtime).await;
            Err(io(error))
        }
    }
}

/// Stops lifecycle admission, then drains App and inbound producers while
/// BTCC and transcript publication remain live.
pub(super) async fn close_serving(
    control: GatewayControlServer,
    gateway: &AppGatewayLifecycle,
    dispatcher: &IngressDispatcher,
    progress: &crate::host::ProgressPublisher,
) -> Result<(), BtccError> {
    control.stop_accepting();
    let admission = measure("app_admission", gateway.stop_accepting()).await;
    let turns = measure("turn_drain", dispatcher.close())
        .await
        .map_err(|e| failure(e.code, e.message));
    let control_close = measure("control_close", control.close())
        .await
        .map_err(|message| {
            failure("gateway_control_close_failed", message.to_string()).with_source(message)
        });
    let publication = measure("progress_reconcile", progress.reconcile())
        .await
        .map(|_| ());
    let app_close = measure("app_close", gateway.close()).await;
    admission
        .and(turns)
        .and(control_close)
        .and(publication)
        .and(app_close)
}

/// Hosts without owner-only modes use external ACL tools off the listener runtime.
pub(super) async fn capture_configuration(
    data: Option<&str>,
    home: &std::path::Path,
    installation: &crate::host::ResolvedInstallation,
) -> Result<crate::host::ServiceConfiguration, BtccError> {
    if butler_platform::secure_fs::OWNER_ONLY {
        return crate::host::ServiceConfiguration::capture(data, home, installation)
            .and_then(require_supported_data);
    }
    let data = data.map(str::to_owned);
    let home = home.to_path_buf();
    let installation = installation.clone();
    tokio::task::spawn_blocking(move || {
        crate::host::ServiceConfiguration::capture(data.as_deref(), &home, &installation)
            .and_then(require_supported_data)
    })
    .await
    .map_err(io)?
}

pub(super) async fn initialize_credentials(
    mut config: crate::host::ServiceConfiguration,
) -> Result<crate::host::ServiceConfiguration, BtccError> {
    if butler_platform::secure_fs::OWNER_ONLY {
        config.initialize_app_credentials();
        return Ok(config);
    }
    tokio::task::spawn_blocking(move || {
        config.initialize_app_credentials();
        config
    })
    .await
    .map_err(io)
}

pub(super) async fn acquire_instance(
    config: &crate::host::ServiceConfiguration,
    executable: std::path::PathBuf,
    supervised: bool,
) -> Result<crate::host::service::instance::InstanceGuard, BtccError> {
    let data = config.data_root.clone();
    let installation = config.installation.clone();
    let acquire = move || {
        crate::host::service::instance::InstanceGuard::acquire(
            &data,
            &executable,
            &installation,
            supervised,
        )
    };
    let instance = if butler_platform::secure_fs::OWNER_ONLY {
        acquire()
    } else {
        tokio::task::spawn_blocking(acquire).await.map_err(io)?
    };
    instance.map_err(|message| {
        failure("native_service_instance_unavailable", message.to_string()).with_source(message)
    })
}

// Refuse before instance locks, credentials or runtime owners can write to DATA.
fn require_supported_data(
    config: crate::host::ServiceConfiguration,
) -> Result<crate::host::ServiceConfiguration, BtccError> {
    use crate::host::runtime::storage_bootstrap::{FreshStorageError, is_unsupported_legacy_data};
    if is_unsupported_legacy_data(&config.data_root) {
        return Err(failure(
            "storage_bootstrap_failed",
            FreshStorageError::ExistingData(config.data_root).to_string(),
        ));
    }
    Ok(config)
}
