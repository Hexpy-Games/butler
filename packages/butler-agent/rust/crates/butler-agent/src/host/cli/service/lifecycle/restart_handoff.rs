//! Detached one-shot restart handoff for a service-owned request.

use std::{
    io::{Read, Write},
    path::Path,
    process::{Child, Command, Stdio},
    sync::mpsc,
    thread,
};

use butler_platform::{process_control, secure_fs};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::managed::{is_managed, is_pid_managed, restart_instance};
use super::{
    StopReport, acquire_admission, active_service, log_file, resolve_data_root,
    service_configuration, start_replacement, stop_service_admitted,
};
use crate::host::ResolvedInstallation;
use crate::host::service::instance as service_instance;
use service_instance::{InstanceRecord, RestartIdentity};

const INTENT_ID_MAX_LEN: usize = 128;
/// The service asked for its own restart; the detached CLI helper carries it out.
const HANDOFF_STOP: service_instance::StopRequest = service_instance::StopRequest {
    reason: service_instance::StopReason::Restart,
    requested_by: service_instance::StopRequester::Cli,
};
const MAX_HANDOFF_INPUT_BYTES: usize = 4096;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RestartHandoffInput {
    identity: RestartIdentity,
    intent_id: String,
}

pub(in crate::host::cli::service) fn spawn_restart_handoff(
    installation: &ResolvedInstallation,
    data_root: &Path,
    expected: &RestartIdentity,
    intent_id: &str,
) -> Result<(), crate::host::HostError> {
    validate_identity(installation, expected)?;
    validate_intent_id(intent_id)?;
    let input = encode_input(expected, intent_id)?;
    let data_root = data_root.canonicalize().map_err(|source| {
        crate::host::HostError::new("native_path_configuration_invalid").with_source(source)
    })?;
    crate::host::service::instance::validate_write_destinations(&data_root, installation)?;
    let current = std::env::current_exe()
        .map_err(|source| {
            crate::host::HostError::new("native_service_executable_unavailable").with_source(source)
        })?
        .canonicalize()
        .map_err(|source| {
            crate::host::HostError::new("native_service_executable_unavailable").with_source(source)
        })?;
    if current.as_path() != installation.executable() {
        return Err("native_service_executable_identity_mismatch".into());
    }

    let logs = data_root.join("logs");
    secure_fs::create_private_dir_all(&logs).map_err(|source| {
        crate::host::HostError::new("native_service_logs_unavailable").with_source(source)
    })?;
    let stdout = log_file(&logs.join("butler-agent-service.stdout.log"), installation)?;
    let stderr = log_file(&logs.join("butler-agent-service.stderr.log"), installation)?;
    let (reaper, receiver) = mpsc::sync_channel::<Child>(1);
    let reaper_thread = thread::Builder::new()
        .name("butler-service-restart-reaper".into())
        .spawn(move || {
            if let Ok(mut child) = receiver.recv() {
                let _ = child.wait();
            }
        })
        .map_err(|source| {
            crate::host::HostError::new("native_service_restart_handoff_reaper_unavailable")
                .with_source(source)
        })?;
    drop(reaper_thread);

    let mut command = Command::new(&current);
    command
        .arg("--installation-root")
        .arg(installation.root())
        .arg("--resource-root")
        .arg(installation.resources())
        .args(["service", "restart-handoff", "--data"])
        .arg(&data_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    process_control::detach(&mut command);
    command.arg("--quiet");
    let mut child = command.spawn().map_err(|source| {
        crate::host::HostError::new("native_service_restart_handoff_spawn_failed")
            .with_source(source)
    })?;
    let Some(mut stdin) = child.stdin.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err("native_service_restart_handoff_input_unavailable".into());
    };
    if stdin.write_all(&input).is_err() {
        drop(stdin);
        let _ = child.kill();
        let _ = child.wait();
        return Err("native_service_restart_handoff_input_unavailable".into());
    }
    drop(stdin);
    if let Err(error) = reaper.send(child) {
        let mut child = error.0;
        let _ = child.kill();
        let _ = child.wait();
        return Err("native_service_restart_handoff_reaper_unavailable".into());
    }
    Ok(())
}

/// A restart the service asks of itself while a login job runs it goes to the
/// manager as one queued request, with the stop intent written first: a helper
/// started from inside the unit would be stopped with it (systemd stops
/// everything in the unit's cgroup), so no process has to outlive the request.
/// Whether the manager took it; when not, the helper carries the restart out.
pub(in crate::host::cli::service) fn asked_of_manager(
    data_root: &Path,
    expected: &RestartIdentity,
) -> bool {
    let Ok(Some(record)) = service_instance::read_record(data_root) else {
        return false;
    };
    if !expected.matches(&record) || !is_pid_managed(data_root, record.pid) {
        return false;
    }
    let intent = service_instance::StopIntent::new(HANDOFF_STOP, &record);
    if service_instance::write_stop_intent(data_root, &intent).is_err() {
        return false;
    }
    match butler_platform::service_registration::restart_detached() {
        Ok(true) => true,
        _ => {
            let _ = service_instance::withdraw_stop_intent(data_root, &record.nonce);
            false
        }
    }
}

pub(in crate::host::cli::service) async fn execute_restart_handoff(
    installation: ResolvedInstallation,
    data_argument: &str,
) -> Result<Value, crate::host::HostError> {
    let input = read_input()?;
    let data_root = resolve_data_root(Some(data_argument), &installation)?;
    let intent_id = input.intent_id.as_str();
    let outcome = restart_once(&installation, &data_root, &input.identity).await;
    let terminal_state = match &outcome {
        Ok(_) => "ready",
        Err((state, _)) => *state,
    };
    let report = crate::host::service::restart_handoff::record_helper_terminal(
        &data_root,
        &installation,
        intent_id,
        terminal_state,
    )
    .await;

    match (outcome, report) {
        (Ok(value), Ok(())) => Ok(value),
        (Ok(_), Err(report_error)) => Err(format!(
            "native_service_restart_handoff_terminal_report_failed: helper reached {terminal_state}; {report_error}"
        ).into()),
        (Err((_, original_error)), Ok(())) => Err(original_error.into()),
        (Err((state, original_error)), Err(report_error)) => Err(format!(
            "{original_error}; helper outcome {state} could not be reported: {report_error}"
        ).into()),
    }
}

async fn restart_once(
    installation: &ResolvedInstallation,
    data_root: &Path,
    expected: &RestartIdentity,
) -> Result<Value, (&'static str, String)> {
    crate::host::service::instance::validate_write_destinations(data_root, installation)
        .map_err(precondition_failure)?;
    validate_identity(installation, expected).map_err(precondition_failure)?;
    let config = service_configuration(installation, data_root).map_err(precondition_failure)?;
    let admission = acquire_admission(data_root, installation)
        .await
        .map_err(precondition_failure)?;
    service_instance::refuse_live_legacy_process(data_root).map_err(precondition_failure)?;
    let active = match active_service(data_root) {
        Ok(Some(active)) => active,
        Ok(None) => {
            return Err((
                "target_gone",
                "native_service_restart_handoff_target_gone".into(),
            ));
        }
        Err(error) => return Err(precondition_failure(error.to_string())),
    };
    validate_target(installation, expected, &active)
        .map_err(|error| ("target_changed", error.to_string()))?;
    if is_managed(data_root, &active) {
        return restart_instance(&config, &active, admission, HANDOFF_STOP.requested_by)
            .await
            .map_err(|error| ("stop_failed", error.to_string()));
    }

    let (stopped, admission) = stop_service_admitted(
        data_root,
        installation,
        admission,
        Some(expected),
        HANDOFF_STOP,
    )
    .await
    .map_err(|error| (stop_failure_state(&error), error.to_string()))?;
    if matches!(stopped, StopReport::AlreadyStopped) {
        drop(admission);
        return Err((
            "target_gone",
            "native_service_restart_handoff_target_gone".into(),
        ));
    }
    let started = start_replacement(installation, &config, admission, &stopped)
        .await
        .map_err(|error| ("start_failed", error.to_string()))?;
    let active = match active_service(data_root) {
        Ok(Some(active)) => active,
        Ok(None) => {
            return Err((
                "start_unverified",
                "native_service_restart_handoff_start_unverified".into(),
            ));
        }
        Err(error) => return Err(("start_unverified", error.to_string())),
    };
    if active.state != "ready"
        || active.ready_at.is_none()
        || active.executable.as_str() != installation.executable().to_string_lossy().as_ref()
        || started["pid"].as_u64() != Some(u64::from(active.pid))
    {
        return Err((
            "start_unverified",
            "native_service_restart_handoff_start_unverified".into(),
        ));
    }
    Ok(started)
}

fn stop_failure_state(error: &crate::host::HostError) -> &'static str {
    if error
        .message()
        .starts_with("native_service_instance_changed")
    {
        "target_changed"
    } else {
        "stop_failed"
    }
}

fn precondition_failure(error: impl std::fmt::Display) -> (&'static str, String) {
    ("precondition_failed", error.to_string())
}

fn validate_target(
    installation: &ResolvedInstallation,
    expected: &RestartIdentity,
    active: &InstanceRecord,
) -> Result<(), crate::host::HostError> {
    if !expected.matches(active)
        || active.state != "ready"
        || active.executable.as_str() != installation.executable().to_string_lossy().as_ref()
    {
        return Err("native_service_restart_handoff_identity_changed".into());
    }
    Ok(())
}

fn validate_identity(
    installation: &ResolvedInstallation,
    expected: &RestartIdentity,
) -> Result<(), crate::host::HostError> {
    if expected.pid == 0
        || expected.process_start.is_empty()
        || expected.nonce.is_empty()
        || expected.executable.is_empty()
        || Path::new(&expected.executable) != installation.executable()
    {
        return Err("native_service_restart_handoff_identity_invalid".into());
    }
    Ok(())
}

fn validate_intent_id(intent_id: &str) -> Result<(), crate::host::HostError> {
    if intent_id.is_empty()
        || intent_id.len() > INTENT_ID_MAX_LEN
        || !intent_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.:".contains(&byte))
    {
        return Err("native_service_restart_handoff_intent_invalid".into());
    }
    Ok(())
}

fn encode_input(
    expected: &RestartIdentity,
    intent_id: &str,
) -> Result<Vec<u8>, crate::host::HostError> {
    validate_intent_id(intent_id)?;
    let bytes = serde_json::to_vec(&RestartHandoffInput {
        identity: expected.clone(),
        intent_id: intent_id.to_owned(),
    })
    .map_err(|source| {
        crate::host::HostError::new("native_service_restart_handoff_input_invalid")
            .with_source(source)
    })?;
    if bytes.is_empty() || bytes.len() > MAX_HANDOFF_INPUT_BYTES {
        return Err("native_service_restart_handoff_input_invalid".into());
    }
    Ok(bytes)
}

fn read_input() -> Result<RestartHandoffInput, crate::host::HostError> {
    let mut input = Vec::new();
    std::io::stdin()
        .lock()
        .take((MAX_HANDOFF_INPUT_BYTES + 1) as u64)
        .read_to_end(&mut input)
        .map_err(|source| {
            crate::host::HostError::new("native_service_restart_handoff_input_unavailable")
                .with_source(source)
        })?;
    if input.is_empty() || input.len() > MAX_HANDOFF_INPUT_BYTES {
        return Err("native_service_restart_handoff_input_invalid".into());
    }
    let envelope: RestartHandoffInput = serde_json::from_slice(&input).map_err(|source| {
        crate::host::HostError::new("native_service_restart_handoff_input_invalid")
            .with_source(source)
    })?;
    validate_intent_id(&envelope.intent_id)?;
    Ok(envelope)
}

#[cfg(test)]
mod tests {
    use super::{MAX_HANDOFF_INPUT_BYTES, RestartHandoffInput, encode_input, validate_intent_id};
    use crate::host::service::instance::RestartIdentity;

    #[test]
    fn handoff_input_is_bounded_strict_and_carries_identity_outside_arguments() {
        {
            assert!(validate_intent_id("turn:call-01").is_ok());
            assert!(validate_intent_id("../../other-data").is_err());
            assert!(validate_intent_id(&"x".repeat(129)).is_err());
        }
        {
            let identity = RestartIdentity {
                pid: 42,
                process_start: "macos:123:456".into(),
                nonce: "private-nonce".into(),
                executable: "/Applications/Butler/butler-agent".into(),
            };
            let encoded = encode_input(&identity, "turn:call-01").expect("valid input");
            let decoded: RestartHandoffInput =
                serde_json::from_slice(&encoded).expect("serialized input parses");
            assert_eq!(decoded.identity, identity);
            assert_eq!(decoded.intent_id, "turn:call-01");
            assert!(encoded.len() <= MAX_HANDOFF_INPUT_BYTES);
        }
        {
            assert!(
                serde_json::from_slice::<RestartHandoffInput>(&vec![
                    b' ';
                    MAX_HANDOFF_INPUT_BYTES + 1
                ])
                .is_err()
            );
            assert!(
                serde_json::from_str::<RestartHandoffInput>(
                    r#"{"identity":{},"intent_id":"x","extra":1}"#
                )
                .is_err()
            );
        }
    }
}
