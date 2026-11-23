//! Restart through the existing same-DATA native lifecycle CLI.

use std::process::Stdio;

use rmcp::model::{CallToolResult, ContentBlock};
use serde_json::Value;
use tokio::process::Command;

use super::super::ResolvedInstallation;

pub(super) async fn restart(
    installation: &ResolvedInstallation,
    data_root: &std::path::Path,
) -> CallToolResult {
    let result = async {
        let mut command = restart_command(installation, data_root, "mcp").await?;
        let output = command
            .kill_on_drop(true)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .await
            .map_err(|error| format!("native_service_restart_failed: {error}"))?;
        restart_result(&output)
    }
    .await;
    match result {
        Ok(pid) => {
            let pid = pid.map(|pid| format!(" (pid={pid})")).unwrap_or_default();
            CallToolResult::success(vec![ContentBlock::text(format!(
                "Butler native service restarted{pid}."
            ))])
        }
        Err(message) => failure(message),
    }
}

pub(crate) async fn restart_service(
    installation: &ResolvedInstallation,
    data_root: &std::path::Path,
    requested_by: &str,
) -> Result<(), String> {
    restart_command(installation, data_root, requested_by)
        .await?
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("native_service_restart_failed: {error}"))?;
    Ok(())
}

async fn restart_command(
    installation: &ResolvedInstallation,
    data_root: &std::path::Path,
    requested_by: &str,
) -> Result<Command, String> {
    let executable = match butler_platform::process_names::current_exe() {
        Ok(path) => path,
        Err(error) => return Err(format!("native_service_executable_unavailable: {error}")),
    };
    let role = butler_platform::process_names::Role::Restart;
    let executable = match butler_platform::process_names::executable_async(&executable, role).await
    {
        Ok(path) => path,
        Err(error) => return Err(format!("native_service_restart_failed: {error}")),
    };
    let mut command = Command::new(executable);
    butler_platform::process_names::name_command(command.as_std_mut(), role);
    command
        .args(["--installation-root"])
        .arg(installation.root())
        .args(["--resource-root"])
        .arg(installation.resources())
        .args(["restart", "--data"])
        .arg(data_root)
        .args(["--json", "--requested-by", requested_by])
        .stdin(Stdio::null());
    Ok(command)
}

fn restart_result(output: &std::process::Output) -> Result<Option<u64>, String> {
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(if message.is_empty() {
            "native_service_restart_failed".into()
        } else {
            message
        });
    }
    let response = serde_json::from_slice::<Value>(&output.stdout).unwrap_or(Value::Null);
    if response["ok"] != true {
        return Err(response["error"]["message"]
            .as_str()
            .unwrap_or("native_service_restart_failed")
            .to_owned());
    }
    Ok(response["data"]["pid"].as_u64())
}

fn failure(message: String) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(message)])
}
