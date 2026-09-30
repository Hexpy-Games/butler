use std::sync::Arc;

use butler_models::models::ModelConfigurationClock;
use butler_turn::btcc::BtccError;

use crate::host::app::gateway_lifecycle::{AppGatewayLifecycle, GatewayControlServer};
use crate::host::service::ingress::IngressDispatcher;
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
    let admission = gateway.stop_accepting().await;
    let turns = dispatcher
        .close()
        .await
        .map_err(|e| failure(e.code, e.message));
    let control_close = control.close().await.map_err(|message| {
        failure("gateway_control_close_failed", message.to_string()).with_source(message)
    });
    let publication = progress.reconcile().await.map(|_| ());
    let app_close = gateway.close().await;
    admission
        .and(turns)
        .and(control_close)
        .and(publication)
        .and(app_close)
}
