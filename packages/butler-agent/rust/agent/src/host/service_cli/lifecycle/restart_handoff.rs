//! Detached one-shot restart handoff for a service-owned request.

use std::{
    fs,
    io::{Read, Write},
    os::unix::fs::DirBuilderExt,
    os::unix::process::CommandExt,
    path::Path,
    process::{Child, Command, Stdio},
    sync::mpsc,
    thread,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::super::super::{ResolvedInstallation, service_instance};
use super::{
    acquire_admission, active_service, log_file, resolve_data_root, service_configuration,
    start_service_admitted, stop_service_admitted,
};
use service_instance::{InstanceRecord, RestartIdentity};

const INTENT_ID_MAX_LEN: usize = 128;
const MAX_HANDOFF_INPUT_BYTES: usize = 4096;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RestartHandoffInput {
    identity: RestartIdentity,
    intent_id: String,
}

pub(in crate::host::service_cli) fn spawn_restart_handoff(
    installation: &ResolvedInstallation,
    data_root: &Path,
    expected: &RestartIdentity,
    intent_id: &str,
) -> Result<(), String> {
    validate_identity(installation, expected)?;
    validate_intent_id(intent_id)?;
    let input = encode_input(expected, intent_id)?;
    let data_root = data_root
        .canonicalize()
        .map_err(|_| "native_path_configuration_invalid".to_owned())?;
    super::super::super::service_instance::validate_write_destinations(&data_root, installation)?;
    let current = std::env::current_exe()
        .map_err(|_| "native_service_executable_unavailable".to_owned())?
        .canonicalize()
        .map_err(|_| "native_service_executable_unavailable".to_owned())?;
    if current.as_path() != installation.executable() {
        return Err("native_service_executable_identity_mismatch".into());
    }

    let logs = data_root.join("logs");
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&logs)
        .map_err(|_| "native_service_logs_unavailable".to_owned())?;
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
        .map_err(|_| "native_service_restart_handoff_reaper_unavailable".to_owned())?;
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
        .stderr(Stdio::from(stderr))
        .process_group(0);
    command.arg("--quiet");
    let mut child = command
        .spawn()
        .map_err(|_| "native_service_restart_handoff_spawn_failed".to_owned())?;
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

pub(in crate::host::service_cli) async fn execute_restart_handoff(
    installation: ResolvedInstallation,
    data_argument: &str,
) -> Result<Value, String> {
    let input = read_input()?;
    let data_root = resolve_data_root(Some(data_argument), &installation)?;
    let intent_id = input.intent_id.as_str();
    let outcome = restart_once(&installation, &data_root, &input.identity).await;
    let terminal_state = match &outcome {
        Ok(_) => "ready",
        Err((state, _)) => *state,
    };
    let report = crate::host::restart_handoff::record_helper_terminal(
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
        )),
        (Err((_, original_error)), Ok(())) => Err(original_error),
        (Err((state, original_error)), Err(report_error)) => Err(format!(
            "{original_error}; helper outcome {state} could not be reported: {report_error}"
        )),
    }
}

async fn restart_once(
    installation: &ResolvedInstallation,
    data_root: &Path,
    expected: &RestartIdentity,
) -> Result<Value, (&'static str, String)> {
    super::super::super::service_instance::validate_write_destinations(data_root, installation)
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
        Err(error) => return Err(precondition_failure(error)),
    };
    validate_target(installation, expected, &active).map_err(|error| ("target_changed", error))?;

    let (stopped, admission) =
        match stop_service_admitted(data_root, installation, admission, Some(expected)).await {
            Ok(result) => result,
            Err(error) => {
                let state = if error.starts_with("native_service_instance_changed") {
                    "target_changed"
                } else {
                    "stop_failed"
                };
                return Err((state, error));
            }
        };
    if stopped["alreadyStopped"] == true {
        drop(admission);
        return Err((
            "target_gone",
            "native_service_restart_handoff_target_gone".into(),
        ));
    }
    let started = start_service_admitted(installation, &config, admission)
        .await
        .map_err(|error| ("start_failed", error))?;
    let active = match active_service(data_root) {
        Ok(Some(active)) => active,
        Ok(None) => {
            return Err((
                "start_unverified",
                "native_service_restart_handoff_start_unverified".into(),
            ));
        }
        Err(error) => return Err(("start_unverified", error)),
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

fn precondition_failure(error: String) -> (&'static str, String) {
    ("precondition_failed", error)
}

fn validate_target(
    installation: &ResolvedInstallation,
    expected: &RestartIdentity,
    active: &InstanceRecord,
) -> Result<(), String> {
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
) -> Result<(), String> {
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

fn validate_intent_id(intent_id: &str) -> Result<(), String> {
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

fn encode_input(expected: &RestartIdentity, intent_id: &str) -> Result<Vec<u8>, String> {
    validate_intent_id(intent_id)?;
    let bytes = serde_json::to_vec(&RestartHandoffInput {
        identity: expected.clone(),
        intent_id: intent_id.to_owned(),
    })
    .map_err(|_| "native_service_restart_handoff_input_invalid".to_owned())?;
    if bytes.is_empty() || bytes.len() > MAX_HANDOFF_INPUT_BYTES {
        return Err("native_service_restart_handoff_input_invalid".into());
    }
    Ok(bytes)
}

fn read_input() -> Result<RestartHandoffInput, String> {
    let mut input = Vec::new();
    std::io::stdin()
        .lock()
        .take((MAX_HANDOFF_INPUT_BYTES + 1) as u64)
        .read_to_end(&mut input)
        .map_err(|_| "native_service_restart_handoff_input_unavailable".to_owned())?;
    if input.is_empty() || input.len() > MAX_HANDOFF_INPUT_BYTES {
        return Err("native_service_restart_handoff_input_invalid".into());
    }
    let envelope: RestartHandoffInput = serde_json::from_slice(&input)
        .map_err(|_| "native_service_restart_handoff_input_invalid".to_owned())?;
    validate_intent_id(&envelope.intent_id)?;
    Ok(envelope)
}

#[cfg(test)]
mod tests {
    use super::{MAX_HANDOFF_INPUT_BYTES, RestartHandoffInput, encode_input, validate_intent_id};
    use crate::host::service_instance::RestartIdentity;

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
