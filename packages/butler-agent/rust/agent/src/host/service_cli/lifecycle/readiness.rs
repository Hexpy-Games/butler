//! Startup readiness and bounded shutdown helpers.

use std::path::Path;
use std::process::Child;
use std::time::{Duration, Instant};

use nix::sys::signal::{Signal, kill};
use nix::unistd::Pid;
use serde_json::Value;

use super::super::super::service_instance::{instance_is_locked, read_record};
use super::super::super::{NativeServiceConfiguration, service_instance::InstanceRecord};
use super::{INSTANCE_PUBLISH_TIMEOUT, POLL_INTERVAL, START_TIMEOUT, active_service};

pub(super) async fn wait_until_ready(
    config: &NativeServiceConfiguration,
    mut child: Option<&mut Child>,
    expected_nonce: Option<String>,
) -> Result<InstanceRecord, String> {
    let deadline = Instant::now() + START_TIMEOUT;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|_| "native_service_readiness_unavailable".to_owned())?;
    let expected_pid = child.as_ref().map(|child| child.id());
    let mut observed_nonce = expected_nonce;
    loop {
        if let Some(process) = child.as_deref_mut()
            && process
                .try_wait()
                .map_err(|_| "native_service_start_child_unavailable".to_owned())?
                .is_some()
        {
            return Err("native_service_start_failed: child exited before readiness".into());
        }
        let active = match active_service(&config.data_root) {
            Ok(active) => active,
            Err(error)
                if child.is_some()
                    && error == "native_service_instance_ambiguous: DATA lock has no record" =>
            {
                None
            }
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
                && app_health_ready(&client, config, &record).await?
            {
                return Ok(record);
            }
            if record.state == "stopping" {
                return Err("native_service_stopped_during_startup".into());
            }
        } else if child.is_none() {
            return Err("native_service_stopped_before_readiness".into());
        }
        if Instant::now() >= deadline {
            return Err("native_service_start_timeout".into());
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

pub(super) async fn wait_until_registered(
    data_root: &Path,
    child: &mut Child,
) -> Result<InstanceRecord, String> {
    let deadline = Instant::now() + INSTANCE_PUBLISH_TIMEOUT;
    loop {
        if child
            .try_wait()
            .map_err(|_| "native_service_start_child_unavailable".to_owned())?
            .is_some()
        {
            return Err("native_service_start_failed: child exited before ownership record".into());
        }
        match active_service(data_root) {
            Ok(Some(record)) if record.pid == child.id() => return Ok(record),
            Ok(Some(_)) => return Err("native_service_start_identity_changed".into()),
            Ok(None) => {}
            Err(error) if error == "native_service_instance_ambiguous: DATA lock has no record" => {
            }
            Err(error) => return Err(error),
        }
        if Instant::now() >= deadline {
            return Err("native_service_start_timeout: ownership record was not published".into());
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

async fn app_health_ready(
    client: &reqwest::Client,
    config: &NativeServiceConfiguration,
    record: &InstanceRecord,
) -> Result<bool, String> {
    if !record.app_enabled {
        return Ok(true);
    }
    let Some(endpoint) = &record.app_endpoint else {
        return Ok(false);
    };
    let auth = config.app.gateway_config().local_auth;
    if record.app_auth_required && (!auth.required || auth.token().is_none()) {
        return Err("native_service_app_health_auth_unavailable".into());
    }
    let mut request = client.get(format!("{endpoint}/runtime-readiness"));
    if auth.required {
        let Some(token) = auth.token() else {
            return Err("native_service_app_health_auth_unavailable".into());
        };
        request = request.bearer_auth(token);
    }
    let response = match request.send().await {
        Ok(response) => response,
        Err(_) => return Ok(false),
    };
    if !response.status().is_success() {
        return Ok(false);
    }
    let value: Value = match response.json().await {
        Ok(value) => value,
        Err(_) => return Ok(false),
    };
    Ok(value["data"]["authenticated_gateway_ready"] == true
        && value["data"]["btcc_executor_ready"] == true
        && value["data"]["raw_text_included"] == false)
}

pub(super) async fn wait_for_stop(
    data_root: &Path,
    nonce: &str,
    timeout: Duration,
) -> Result<bool, String> {
    let deadline = Instant::now() + timeout;
    loop {
        let locked = instance_is_locked(data_root)?;
        let current = read_record(data_root)?;
        if current.as_ref().is_some_and(|record| record.nonce != nonce) {
            return Ok(true);
        }
        if current.is_none() && !locked {
            return Ok(true);
        }
        if !locked && current.as_ref().is_some_and(|record| record.nonce == nonce) {
            return Ok(true);
        }
        if Instant::now() >= deadline {
            return Ok(false);
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

pub(super) async fn cleanup_spawned(mut child: Child) {
    let pid = child.id();
    if child.try_wait().ok().flatten().is_some() {
        return;
    }
    if let Ok(pid) = i32::try_from(pid) {
        let _ = kill(Pid::from_raw(pid), Signal::SIGTERM);
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(_)) | Err(_) => return,
            Ok(None) if Instant::now() >= deadline => break,
            Ok(None) => tokio::time::sleep(POLL_INTERVAL).await,
        }
    }
    // Child::try_wait keeps a live direct child unreaped, so the PID cannot be
    // recycled between this final identity check and Child::kill.
    if child.try_wait().ok().flatten().is_none() {
        let _ = child.kill();
        let _ = child.wait();
    }
}
