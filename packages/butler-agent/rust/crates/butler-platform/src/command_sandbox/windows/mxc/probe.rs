//! Probe PSEC in the helper, followed by a USER32-importing contained child.
use super::{Error, SandboxCapabilities, helper, sdk};
use crate::command_sandbox::{
    Invocation, Level, host_capabilities::unavailable, mxc_policy::command_line::command_line,
};
use serde_json::{Value, json};
use std::process::{Command, Stdio};

pub(in crate::command_sandbox) fn probe() -> SandboxCapabilities {
    if std::env::var("BUTLER_WINDOWS_PROJECT_SANDBOX").as_deref() != Ok("1") {
        return unavailable("mxc_disabled");
    }
    let Ok(helper) = helper().and_then(|p| {
        if p.is_file() {
            Ok(p)
        } else {
            Err(std::io::Error::other("helper_missing"))
        }
    }) else {
        return unavailable("helper_missing");
    };
    let output = Command::new(helper)
        .arg("--probe")
        .stdin(Stdio::null())
        .output();
    let reason = output
        .ok()
        .and_then(|out| String::from_utf8(out.stdout).ok());
    match reason.as_deref().map(str::trim) {
        Some("partial") => SandboxCapabilities {
            project_write: Level::Partial("new secret names are swept after the run"),
            network_deny: Level::Enforced,
            process_scoping: Level::Unavailable("Windows non-file channels are not qualified"),
            ..unavailable("Windows observations are not contained")
        },
        Some("mxc_disabled") => unavailable("mxc_disabled"),
        Some("mxc_api_missing") => unavailable("mxc_api_missing"),
        Some("base_container_unavailable") => unavailable("base_container_unavailable"),
        Some("native_deny_unsupported") => unavailable("native_deny_unsupported"),
        Some("dacl_fallback_required") => unavailable("dacl_fallback_required"),
        Some("non_interactive_desktop") => unavailable("non_interactive_desktop"),
        Some("privilege_not_held") => unavailable("privilege_not_held"),
        _ => unavailable("probe_failed"),
    }
}

pub(super) fn helper_probe() -> Result<&'static str, Error> {
    if std::env::var("BUTLER_WINDOWS_PROJECT_SANDBOX").as_deref() != Ok("1") {
        return Ok("mxc_disabled");
    }
    let exe = dunce::canonicalize(std::env::current_exe()?)?;
    let system = std::env::var("SYSTEMROOT")?;
    let local = std::env::var("LOCALAPPDATA")?;
    let nonce = format!("butler-probe-{}", std::process::id());
    let command = command_line(&Invocation {
        program: exe.to_string_lossy().into(),
        arguments: vec!["--probe-child".into(), nonce.clone()],
    })?;
    let request = json!({
        "version":"1.0.0", "containment":"processcontainer",
        "fallback":{"allowDaclMutation":false},
        "lifecycle":{"destroyOnExit":true,"preservePolicy":false},
        "telemetry":{"enabled":false}, "ui":{"clipboard":"none","injection":false},
        "network":{"ingress":{"default":"deny","hostLoopback":"deny"},"egress":{"default":"deny"}},
        "process":{"commandLine":command,"cwd":exe.parent(),"env":[format!("SYSTEMROOT={system}"),format!("LOCALAPPDATA={local}")],"inheritDefaultEnv":false,"timeout":10000},
        "filesystem":{"readonlyPaths":[exe.parent(),system],"readwritePaths":[],"deniedPaths":[]}
    });
    let facts = match sdk::probe(&request) {
        Ok(facts) => facts,
        Err(reason) => return Ok(reason),
    };
    if !facts
        .pointer("/probes/baseContainerApiPresent")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Ok("mxc_api_missing");
    }
    if facts.get("tier").and_then(Value::as_str) != Some("base-container") {
        return Ok("base_container_unavailable");
    }
    if facts.get("needsDaclAugmentation").and_then(Value::as_bool) != Some(false) {
        return Ok("dacl_fallback_required");
    }
    if facts
        .pointer("/probes/baseContainerSupportsDenyPaths")
        .and_then(Value::as_bool)
        != Some(true)
    {
        return Ok("native_deny_unsupported");
    }
    sdk::child_probe(&request, &nonce)
}

pub(super) fn rewrite_drive(request: &mut Value, drive: char, relative: &str) -> Result<(), Error> {
    let cwd = format!("{drive}:\\{relative}");
    *request.pointer_mut("/process/cwd").ok_or("missing cwd")? = cwd.clone().into();
    let env = request
        .pointer_mut("/process/env")
        .and_then(Value::as_array_mut)
        .ok_or("missing environment")?;
    for item in env {
        if item
            .as_str()
            .is_some_and(|s| s.starts_with("BUTLER_COMMAND_CWD="))
        {
            *item = format!("BUTLER_COMMAND_CWD={cwd}").into();
        }
    }
    Ok(())
}
