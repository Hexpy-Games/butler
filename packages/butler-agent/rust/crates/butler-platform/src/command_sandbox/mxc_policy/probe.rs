//! Minimal USER32 loader policy and privacy-safe diagnostic projection.
use super::{WinPath, command_line::command_line};
use crate::command_sandbox::Invocation;
use serde_json::{Value, json};

/// Grants physical loader roots and supplies only the required system environment.
pub fn request(
    exe: &WinPath,
    directory: &WinPath,
    system: &WinPath,
    nonce: &str,
) -> Result<Value, &'static str> {
    let command = command_line(&Invocation {
        program: exe.as_str().into(),
        arguments: vec!["--probe-child".into(), nonce.into()],
    })?;
    Ok(json!({
        "version":"1.0.0", "containment":"processcontainer",
        "fallback":{"allowDaclMutation":false},
        "lifecycle":{"destroyOnExit":true,"preservePolicy":false},
        "telemetry":{"enabled":false},
        "ui":{"disable":false,"clipboard":"none","injection":false},
        "network":{"ingress":{"default":"deny","hostLoopback":"deny"},"egress":{"default":"deny"}},
        "process":{"commandLine":command,"cwd":directory,"env":[
            format!("SYSTEMROOT={}",system.as_str()),format!("WINDIR={}",system.as_str()),
            format!("PATH={};{}",directory.as_str(),system.join("System32")?.as_str())
        ],"inheritDefaultEnv":false,"timeout":10000},
        "filesystem":{"readonlyPaths":[directory,system],"readwritePaths":[],"deniedPaths":[]}
    }))
}

/// Keep drive, depth and extension, never private directory or file names.
pub fn path_shape(path: &str) -> String {
    path.split('\\')
        .enumerate()
        .map(|(i, part)| {
            if i == 0 && part.ends_with(':') {
                return part.to_owned();
            }
            match part.rsplit_once('.') {
                Some((_, ext))
                    if ext.eq_ignore_ascii_case("exe") || ext.eq_ignore_ascii_case("dll") =>
                {
                    format!("<file>.{ext}")
                }
                _ => "<dir>".into(),
            }
        })
        .collect::<Vec<_>>()
        .join("\\")
}

/// Redact every path-bearing field; environment values are deliberately omitted.
pub fn redacted(request: &Value) -> Value {
    let mut value = request.clone();
    if let Some(command) = value.pointer_mut("/process/commandLine") {
        *command = "<helper.exe> --probe-child <nonce>".into();
    }
    if let Some(cwd) = value.pointer_mut("/process/cwd") {
        *cwd = path_shape(cwd.as_str().unwrap_or_default()).into();
    }
    if let Some(env) = value
        .pointer_mut("/process/env")
        .and_then(Value::as_array_mut)
    {
        for entry in env {
            let key = entry
                .as_str()
                .unwrap_or_default()
                .split('=')
                .next()
                .unwrap_or_default();
            *entry = format!("{key}=<redacted>").into();
        }
    }
    for field in ["readonlyPaths", "readwritePaths", "deniedPaths"] {
        if let Some(paths) = value
            .get_mut("filesystem")
            .and_then(|fs| fs.get_mut(field))
            .and_then(Value::as_array_mut)
        {
            for path in paths {
                *path = path_shape(path.as_str().unwrap_or_default()).into();
            }
        }
    }
    value
}
