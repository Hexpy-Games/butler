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
    let executable = match std::env::current_exe() {
        Ok(path) => path,
        Err(error) => return failure(format!("native_service_executable_unavailable: {error}")),
    };
    let output = Command::new(executable)
        .kill_on_drop(true)
        .args(["--installation-root"])
        .arg(installation.root())
        .args(["--resource-root"])
        .arg(installation.resources())
        .args(["restart", "--data"])
        .arg(data_root)
        .arg("--json")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await;
    let output = match output {
        Ok(output) => output,
        Err(error) => return failure(format!("native_service_restart_failed: {error}")),
    };
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return failure(if message.is_empty() {
            "native_service_restart_failed".into()
        } else {
            message
        });
    }
    let response = serde_json::from_slice::<Value>(&output.stdout).unwrap_or(Value::Null);
    if response["ok"] != true {
        return failure(
            response["error"]["message"]
                .as_str()
                .unwrap_or("native_service_restart_failed")
                .to_owned(),
        );
    }
    let pid = response["data"]["pid"]
        .as_u64()
        .map(|pid| format!(" (pid={pid})"))
        .unwrap_or_default();
    CallToolResult::success(vec![ContentBlock::text(format!(
        "Butler native service restarted{pid}."
    ))])
}

fn failure(message: String) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(message)])
}
