//! Start inside the container before PowerShell caches its policy/temp paths.
use super::Error;
use crate::command_sandbox::{Invocation, mxc_policy::command_line::command_line};
use serde_json::Value;
use std::{fs, io::Write, path::Path};

pub(super) fn prepare(request: &mut Value, scratch: &Path, temporary: &str) -> Result<(), Error> {
    let original = request
        .pointer("/process/commandLine")
        .and_then(Value::as_str)
        .ok_or("missing command line")?
        .to_owned();
    let env = request
        .pointer_mut("/process/env")
        .and_then(Value::as_array_mut)
        .ok_or("missing environment")?;
    let script = env
        .iter()
        .filter_map(Value::as_str)
        .find_map(|s| s.strip_prefix("BUTLER_COMMAND_SCRIPT="))
        .map(str::to_owned);
    let line = if let Some(script) = script {
        // BOM is required for Windows PowerShell 5.1's non-ASCII script input.
        // -Command reports a false final $? as 1; -File otherwise returns 0.
        write_new(
            &scratch.join("t/command.ps1"),
            format!("\u{feff}{script}\r\nif (!$?) {{ exit 1 }}\r\n").as_bytes(),
        )?;
        env.retain(|v| {
            !v.as_str()
                .is_some_and(|s| s.starts_with("BUTLER_COMMAND_SCRIPT="))
        });
        env.push(format!("BUTLER_COMMAND_FILE={temporary}\\command.ps1").into());
        "\"%BUTLER_COMMAND_SHELL%\" -NoLogo -NoProfile -NonInteractive -OutputFormat Text -ExecutionPolicy Bypass -File \"%BUTLER_COMMAND_FILE%\"".to_owned()
    } else {
        // Expand once from the environment: batch-file percent rules must not
        // reinterpret the original cmd text before its own shell parses it.
        env.push(format!("BUTLER_COMMAND_LINE={original}").into());
        "%BUTLER_COMMAND_LINE%".to_owned()
    };
    // MXC replaces TEMP/TMP with its package profile during process creation.
    // Reset them *inside* the container, on separate batch lines so expansion
    // observes the corrected values. No grants or application policies change.
    write_new(&scratch.join("t/start.cmd"), format!(
        "@echo off\r\nchcp 65001>nul\r\nset \"BUTLER_CONTAINER_TEMP=%TEMP%\"\r\nset \"BUTLER_CONTAINER_TMP=%TMP%\"\r\nset \"TEMP=%BUTLER_COMMAND_TEMP%\"\r\nset \"TMP=%BUTLER_COMMAND_TEMP%\"\r\n{line}\r\nexit /b %errorlevel%\r\n"
    ).as_bytes())?;
    env.push(format!("BUTLER_COMMAND_TEMP={temporary}").into());
    env.push(format!("BUTLER_COMMAND_START={temporary}\\start.cmd").into());
    let comspec = env
        .iter()
        .filter_map(Value::as_str)
        .find_map(|s| s.strip_prefix("COMSPEC="))
        .ok_or("COMSPEC required")?
        .to_owned();
    let invocation = Invocation {
        program: comspec,
        arguments: ["/d", "/v:off", "/s", "/c", "\"%BUTLER_COMMAND_START%\""]
            .map(str::to_owned)
            .to_vec(),
        ..Default::default()
    };
    *request
        .pointer_mut("/process/commandLine")
        .ok_or("missing command line")? = command_line(&invocation)?.into();
    Ok(())
}
fn write_new(path: &Path, bytes: &[u8]) -> Result<(), Error> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    file.write_all(bytes)?;
    Ok(())
}

#[cfg(feature = "test-support")]
#[path = "shell_fixture.rs"]
mod fixture;
#[cfg(feature = "test-support")]
pub(in crate::command_sandbox) use fixture::verify;
