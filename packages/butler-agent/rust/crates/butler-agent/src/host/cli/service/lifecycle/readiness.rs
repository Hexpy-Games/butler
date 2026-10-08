//! Startup readiness and bounded shutdown helpers.

use std::path::Path;
use std::process::Child;
use std::time::{Duration, Instant};

use butler_platform::instance::{StopError, request_stop};
use serde::Deserialize;

use super::probe_auth::{is_loopback_endpoint, probe_tokens};
use super::{
    APP_RESPAWN_TIMEOUT, INSTANCE_PUBLISH_TIMEOUT, LOCK_WITHOUT_RECORD, POLL_INTERVAL,
    START_TIMEOUT, active_service,
};
use crate::host::ServiceConfiguration;
use crate::host::service::instance::{
    InstanceRecord, instance_is_locked, read_record, record_process_gone,
};

pub(super) async fn wait_until_ready(
    config: &ServiceConfiguration,
    mut child: Option<&mut Child>,
    expected_nonce: Option<String>,
) -> Result<InstanceRecord, crate::host::HostError> {
    let mut deadline = Instant::now() + START_TIMEOUT;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|source| {
            crate::host::HostError::new("native_service_readiness_unavailable").with_source(source)
        })?;
    let expected_pid = child.as_ref().map(|child| child.id());
    let mut observed_nonce = expected_nonce;
    loop {
        if let Some(process) = child.as_deref_mut()
            && process
                .try_wait()
                .map_err(|source| {
                    crate::host::HostError::new("native_service_start_child_unavailable")
                        .with_source(source)
                })?
                .is_some()
        {
            return Err("native_service_start_failed: child exited before readiness".into());
        }
        let active = match active_service(&config.data_root) {
            Ok(active) => active,
            Err(error) if child.is_some() && error.message() == LOCK_WITHOUT_RECORD => None,
            Err(error) => return Err(error),
        };
        if let Some(record) = active {
            if expected_pid.is_some_and(|pid| pid != record.pid) {
                return Err("native_service_start_identity_changed".into());
            }
            if let Some(expected) = &observed_nonce {
                if expected != &record.nonce {
                    return Err("native_service_instance_changed".into());
                }
            } else {
                observed_nonce = Some(record.nonce.clone());
            }
            if record.state == "ready"
                && record.ready_at.is_some()
                && app_health_ready(&client, config, &record).await
            {
                return Ok(record);
            }
            if record.state == "stopping" {
                return Err("native_service_stopped_during_startup".into());
            }
        } else if child.is_none() {
            return Err("native_service_stopped_before_readiness".into());
        }
        deadline = storage_deadline(&config.data_root)
            .await
            .map_or(deadline, |extended| deadline.max(extended));
        if Instant::now() >= deadline {
            return Err("native_service_start_timeout".into());
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

pub(super) async fn wait_until_registered(
    data_root: &Path,
    child: &mut Child,
) -> Result<InstanceRecord, crate::host::HostError> {
    let deadline = Instant::now() + INSTANCE_PUBLISH_TIMEOUT;
    loop {
        if child
            .try_wait()
            .map_err(|source| {
                crate::host::HostError::new("native_service_start_child_unavailable")
                    .with_source(source)
            })?
            .is_some()
        {
            return Err("native_service_start_failed: child exited before ownership record".into());
        }
        match active_service(data_root) {
            Ok(Some(record)) if record.cli_supervisor_pid == Some(child.id()) => return Ok(record),
            Ok(Some(_)) => return Err("native_service_start_identity_changed".into()),
            Ok(None) => {}
            Err(error) if error.message() == LOCK_WITHOUT_RECORD => {}
            Err(error) => return Err(error),
        }
        if Instant::now() >= deadline {
            return Err("native_service_start_timeout: ownership record was not published".into());
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

/// Waits for the App to start the instance that replaces the one with
/// `previous_nonce` (restart of an App-supervised instance) and returns the
/// replacement's record once it is published.
pub(super) async fn wait_for_app_respawn(
    data_root: &Path,
    previous_nonce: &str,
) -> Result<InstanceRecord, crate::host::HostError> {
    let deadline = Instant::now() + APP_RESPAWN_TIMEOUT;
    loop {
        match active_service(data_root) {
            Ok(Some(record)) if record.nonce != previous_nonce => return Ok(record),
            Ok(_) => {}
            Err(error) if error.message() == LOCK_WITHOUT_RECORD => {}
            Err(error) => return Err(error),
        }
        if Instant::now() >= deadline {
            return Err(
                "native_service_app_respawn_timeout: the Butler App or the service manager did not start the service again"
                    .into(),
            );
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

/// Whether the App gateway the ready record names answers its readiness probe.
///
/// A gateway that requires local auth is probed with the tokens this CLI can
/// find ([`probe_tokens`]). When none is available, or the gateway is not on
/// loopback, the ready record is authoritative: the service marks itself ready
/// only after its App gateway is listening, and the caller has already checked
/// the DATA lock and the process identity.
async fn app_health_ready(
    client: &reqwest::Client,
    config: &ServiceConfiguration,
    record: &InstanceRecord,
) -> bool {
    if !record.app_enabled {
        return true;
    }
    let Some(endpoint) = &record.app_endpoint else {
        return false;
    };
    let url = format!("{endpoint}/runtime-readiness");
    if !record.app_auth_required {
        return readiness_probe(client, &url, None).await;
    }
    let tokens = if is_loopback_endpoint(endpoint) {
        probe_tokens(config)
    } else {
        Vec::new()
    };
    if tokens.is_empty() {
        return true;
    }
    for token in &tokens {
        if readiness_probe(client, &url, Some(token)).await {
            return true;
        }
    }
    false
}

/// Envelope of `GET /runtime-readiness`.
#[derive(Deserialize)]
struct ReadinessEnvelope {
    data: ReadinessView,
}

/// The readiness fields the CLI waits for.
#[derive(Deserialize)]
struct ReadinessView {
    authenticated_gateway_ready: bool,
    btcc_executor_ready: bool,
    raw_text_included: bool,
}

async fn readiness_probe(client: &reqwest::Client, url: &str, token: Option<&str>) -> bool {
    let mut request = client.get(url);
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    let Ok(response) = request.send().await else {
        return false;
    };
    if !response.status().is_success() {
        return false;
    }
    response
        .json::<ReadinessEnvelope>()
        .await
        .is_ok_and(|envelope| {
            envelope.data.authenticated_gateway_ready
                && envelope.data.btcc_executor_ready
                && !envelope.data.raw_text_included
        })
}

pub(super) async fn wait_for_stop(
    data_root: &Path,
    stopped: &InstanceRecord,
    timeout: Duration,
) -> Result<bool, crate::host::HostError> {
    let deadline = Instant::now() + timeout;
    loop {
        let locked = instance_is_locked(data_root)?;
        let current = read_record(data_root)?;
        let replaced = current
            .as_ref()
            .is_some_and(|record| record.nonce != stopped.nonce);
        // Releasing the instance file precedes runtime/process teardown. A
        // successful stop must also observe the original OS identity gone;
        // a reused PID or a ready replacement is a different process.
        if (replaced || !locked) && record_process_gone(stopped)? {
            return Ok(true);
        }
        if Instant::now() >= deadline {
            return Ok(false);
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

/// Stops a child whose start failed: a stop request first (SIGTERM), then,
/// after 5 s or where the host has no stop request (Windows), a kill.
pub(super) async fn cleanup_spawned(mut child: Child) {
    let pid = child.id();
    if child.try_wait().ok().flatten().is_some() {
        return;
    }
    if !matches!(request_stop(pid), Err(StopError::Unsupported)) {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match child.try_wait() {
                Ok(Some(_)) | Err(_) => return,
                Ok(None) if Instant::now() >= deadline => break,
                Ok(None) => tokio::time::sleep(POLL_INTERVAL).await,
            }
        }
    }
    // Child::try_wait keeps a live direct child unreaped, so the PID cannot be
    // recycled between this final identity check and Child::kill.
    if child.try_wait().ok().flatten().is_none() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Read only the bounded startup progress record, outside Tokio workers.
async fn storage_deadline(data: &Path) -> Option<Instant> {
    let path = data.join("agent-runtime/storage-correction.json");
    let time = tokio::task::spawn_blocking(move || {
        let raw = std::fs::read_to_string(path).ok()?;
        let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
        if value["schema"] != "butler.storage-correction-progress.v1" {
            return None;
        }
        chrono::DateTime::parse_from_rfc3339(value["deadlineAt"].as_str()?).ok()
    })
    .await
    .ok()??;
    let remaining = (time.with_timezone(&chrono::Utc) + chrono::Duration::seconds(30)
        - chrono::Utc::now())
    .to_std()
    .ok()?;
    Some(Instant::now() + remaining)
}
