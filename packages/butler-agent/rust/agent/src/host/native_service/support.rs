use std::sync::Arc;

use crate::btcc::BtccError;
use crate::models::ModelConfigurationClock;

use super::super::{NativeAgentRuntime, SystemIdentity};

pub(super) async fn deliver_parent_results(
    client: &reqwest::Client,
    repository: &crate::btcc::SqliteSubsessionRepository,
    base: &str,
    auth: &crate::gateway::LocalAuthConfig,
) -> Result<(), BtccError> {
    for pending in repository
        .pending_parent_inputs()
        .await
        .map_err(|error| failure(error.code(), error.message()))?
    {
        if pending.route != crate::btcc::ParentResultRoute::ButlerApp {
            continue;
        }
        let body = serde_json::to_string(&pending.input)
            .map_err(|error| failure("app_subsession_result_invalid", error.to_string()))?;
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

pub(super) fn io(error: impl std::fmt::Display) -> BtccError {
    failure("native_service_io_failed", error.to_string())
}

pub(super) fn failure(code: impl Into<String>, message: impl Into<String>) -> BtccError {
    BtccError::relayed(code.into(), message)
}

pub(super) async fn close_runtime(runtime: Arc<NativeAgentRuntime>) -> Result<(), BtccError> {
    match Arc::try_unwrap(runtime) {
        Ok(runtime) => runtime.close().await,
        Err(_) => Err(failure(
            "native_runtime_owner_leaked",
            "Native runtime has an owner after service shutdown",
        )),
    }
}
