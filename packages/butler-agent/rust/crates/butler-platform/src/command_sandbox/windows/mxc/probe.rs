//! Probe PSEC in the helper, followed by a USER32-importing contained child.
use super::{Error, SandboxCapabilities, helper, sdk};
use crate::command_sandbox::{Level, host_capabilities::unavailable, mxc_policy};
use serde_json::{Value, json};
use std::path::Path;
use std::process::{Command, Stdio};

pub(in crate::command_sandbox) fn probe() -> SandboxCapabilities {
    if std::env::var("BUTLER_WINDOWS_PROJECT_SANDBOX").as_deref() == Ok("0") {
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
        Some("child_dll_initialization_failed") => unavailable("child_dll_initialization_failed"),
        Some("child_dll_not_found") => unavailable("child_dll_not_found"),
        Some("child_invalid_image") => unavailable("child_invalid_image"),
        Some("child_exit_failed") => unavailable("child_exit_failed"),
        Some("child_output_mismatch") => unavailable("child_output_mismatch"),
        Some("child_timed_out") => unavailable("child_timed_out"),
        Some("mxc_policy_invalid") => unavailable("mxc_policy_invalid"),
        Some("mxc_spawn_failed") => unavailable("mxc_spawn_failed"),
        Some("mxc_probe_failed") => unavailable("mxc_probe_failed"),
        Some("probe_setup_failed") => unavailable("probe_setup_failed"),
        _ => unavailable("probe_failed"),
    }
}

pub(super) fn helper_probe(diagnostic: Option<&Path>) -> Result<String, Error> {
    let mut report = json!({"reason":"probe_setup_failed","policy":null,
        "childExitCode":null,"childNtstatus":null,"stderr":"","mxcError":null});
    if let Err(error) = execute_probe(&mut report) {
        set(
            report.as_object_mut(),
            "setupError",
            error.to_string().into(),
        );
    }
    let reason = report
        .get("reason")
        .and_then(Value::as_str)
        .unwrap_or("probe_setup_failed")
        .to_owned();
    if let Some(path) = diagnostic {
        std::fs::write(path, serde_json::to_vec_pretty(&report)?)?;
    }
    eprintln!("{report}");
    Ok(reason)
}

fn set(object: Option<&mut serde_json::Map<String, Value>>, key: &str, value: Value) {
    if let Some(object) = object {
        object.insert(key.into(), value);
    }
}

fn execute_probe(report: &mut Value) -> Result<(), Error> {
    if std::env::var("BUTLER_WINDOWS_PROJECT_SANDBOX").as_deref() == Ok("0") {
        set(report.as_object_mut(), "reason", "mxc_disabled".into());
        return Ok(());
    }
    let exe = crate::secure_fs::canonicalize(std::env::current_exe()?)?;
    let directory = exe.parent().ok_or("missing helper directory")?;
    let system = crate::secure_fs::canonicalize(std::env::var("SYSTEMROOT")?)?;
    let local = crate::secure_fs::canonicalize(std::env::var("LOCALAPPDATA")?)?;
    let nonce = format!("butler-probe-{}", std::process::id());
    let request = mxc_policy::probe::request(
        &super::prepare::physical(&exe)?,
        &super::prepare::physical(directory)?,
        &super::prepare::physical(&system)?,
        &super::prepare::physical(&local)?,
        &nonce,
    )?;
    set(
        report.as_object_mut(),
        "policy",
        mxc_policy::probe::redacted(&request),
    );
    if !interactive_desktop()? {
        set(
            report.as_object_mut(),
            "reason",
            "non_interactive_desktop".into(),
        );
        return Ok(());
    }
    let facts = match sdk::probe(&request) {
        Ok(facts) => facts,
        Err(error) => {
            let details = if let Some(error) = error.downcast_ref::<mxc_sdk::v1::Error>() {
                sdk::error_report(error, "mxc_probe_failed")
            } else {
                json!({"reason":"mxc_probe_failed","setupError":error.to_string()})
            };
            report
                .as_object_mut()
                .ok_or("invalid report")?
                .extend(details.as_object().ok_or("invalid details")?.clone());
            redact_details(report, &request);
            return Ok(());
        }
    };
    set(report.as_object_mut(), "capabilities", facts.clone());
    let reason = capability_reason(&facts);
    if let Some(reason) = reason {
        set(report.as_object_mut(), "reason", reason.into());
    } else {
        let details = sdk::child_probe(&request, &nonce);
        report
            .as_object_mut()
            .ok_or("invalid report")?
            .extend(details.as_object().ok_or("invalid child report")?.clone());
    }
    redact_details(report, &request);
    Ok(())
}

fn capability_reason(facts: &Value) -> Option<&'static str> {
    if facts
        .pointer("/probes/baseContainerApiPresent")
        .and_then(Value::as_bool)
        != Some(true)
    {
        Some("mxc_api_missing")
    } else if facts.get("tier").and_then(Value::as_str) != Some("base-container") {
        Some("base_container_unavailable")
    } else if facts.get("needsDaclAugmentation").and_then(Value::as_bool) != Some(false) {
        Some("dacl_fallback_required")
    } else if facts
        .pointer("/probes/baseContainerSupportsDenyPaths")
        .and_then(Value::as_bool)
        != Some(true)
    {
        Some("native_deny_unsupported")
    } else {
        None
    }
}

fn redact_details(report: &mut Value, request: &Value) {
    let mut paths = vec![
        std::env::current_exe()
            .ok()
            .map(|p| p.display().to_string())
            .unwrap_or_default(),
    ];
    for field in ["readonlyPaths", "readwritePaths", "deniedPaths"] {
        if let Some(values) = request
            .get("filesystem")
            .and_then(|fs| fs.get(field))
            .and_then(Value::as_array)
        {
            paths.extend(values.iter().filter_map(Value::as_str).map(str::to_owned));
        }
    }
    if let Some(env) = request.pointer("/process/env").and_then(Value::as_array) {
        for entry in env.iter().filter_map(Value::as_str) {
            if let Some((_, value)) = entry.split_once('=') {
                paths.extend(value.split(';').map(str::to_owned));
            }
        }
    }
    paths.sort_by_key(|path| std::cmp::Reverse(path.len()));
    scrub(report, &paths);
}

fn scrub(value: &mut Value, paths: &[String]) {
    match value {
        Value::String(text) => {
            for path in paths.iter().filter(|p| !p.is_empty()) {
                // Canonical paths may differ only in case from SDK messages.
                while let Some(index) = text.to_ascii_lowercase().find(&path.to_ascii_lowercase()) {
                    text.replace_range(
                        index..index + path.len(),
                        &mxc_policy::probe::path_shape(path),
                    );
                }
            }
        }
        Value::Object(object) => {
            for value in object.values_mut() {
                scrub(value, paths);
            }
        }
        Value::Array(array) => {
            for value in array {
                scrub(value, paths);
            }
        }
        _ => {}
    }
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

// Query the current process window station directly; never launch a host shell.
fn interactive_desktop() -> Result<bool, Error> {
    Ok(notify_windows_ledger::interactive_desktop()?)
}
