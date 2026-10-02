//! One readiness predicate for spawned children and detached replacements.
use super::{HarnessError, gateway::Gateway, harness_error, stop_intent};
use serde_json::Value;
use std::path::Path;
use std::time::{Duration, Instant};

/// A served gateway and ready instance, for barriers that deliberately hold the executor.
pub(super) async fn serving_record(data: &Path, gateway: &Gateway) -> Option<Value> {
    let record = stop_intent::instance_record(data)?;
    (stop_intent::instance_ready(&record) && gateway.healthy().await).then_some(record)
}

/// Require a ready instance, authenticated gateway, and executor belonging to it.
pub async fn ready_record(data: &Path, gateway: &Gateway) -> Option<Value> {
    let record = serving_record(data, gateway).await?;
    let readiness = gateway.get("/runtime-readiness").await.ok()?;
    if readiness.status != 200
        || readiness.data()["authenticated_gateway_ready"] != true
        || readiness.data()["btcc_executor_ready"] != true
        || readiness.data()["executor_pid"] != record["pid"]
    {
        return None;
    }
    // A replacement must not switch the instance underneath the HTTP probes.
    let current = stop_intent::instance_record(data)?;
    (current["nonce"] == record["nonce"] && stop_intent::instance_ready(&current))
        .then_some(current)
}

pub async fn wait_ready(
    data: &Path,
    gateway: &Gateway,
    within: Duration,
    accepts: impl Fn(&Value) -> bool,
) -> Result<Value, HarnessError> {
    let deadline = Instant::now() + within;
    loop {
        if let Some(record) = ready_record(data, gateway).await.filter(&accepts) {
            return Ok(record);
        }
        if Instant::now() >= deadline {
            return Err(harness_error(
                "gateway, executor and instance did not become ready",
            ));
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// CLI start/update returns a ready instance before its initial dispatch poll.
/// Synchronous installer tests still use the same full readiness predicate.
pub async fn wait_launch_ready(
    launch: &super::agent::Launch,
    within: Duration,
) -> Result<Value, HarnessError> {
    let record = stop_intent::instance_record(&launch.data)
        .ok_or_else(|| harness_error("CLI start returned without an instance record"))?;
    let endpoint = record["app_endpoint"]
        .as_str()
        .ok_or_else(|| harness_error("ready instance has no gateway endpoint"))?;
    let token = if launch.token.is_empty() {
        launch
            .data_folder_token()
            .ok_or_else(|| harness_error("ready instance has no gateway credential"))?
    } else {
        launch.token.clone()
    };
    let gateway = Gateway::new(endpoint.to_owned(), token);
    wait_ready(&launch.data, &gateway, within, |_| true).await
}

/// The synchronous CLI tests have no Tokio runtime of their own.
pub fn wait_launch_ready_blocking(
    launch: &super::agent::Launch,
    within: Duration,
) -> Result<Value, HarnessError> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?
        .block_on(wait_launch_ready(launch, within))
}
