//! Helpers of the install scenarios that run the CLI without a service:
//! a sandbox whose Agent home is `root/agent-home`, and JSON results.
#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "each scenario file uses some of the helpers; test assertions"
)]

use std::process::Stdio;

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::agent::{CliOutput, Launch};
use butler_e2e::e2e::sandbox::Sandbox;
use serde_json::Value;

pub(crate) fn run(command: &mut std::process::Command) -> Result<CliOutput, HarnessError> {
    let output = command.stdin(Stdio::null()).output()?;
    Ok(CliOutput {
        code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

/// A sandbox whose Agent home is `root/agent-home`.
pub(crate) fn sandbox(id: &str) -> Result<(Sandbox, Launch), HarnessError> {
    let sandbox = Sandbox::new(id)?;
    let mut launch = Launch::new(&sandbox)?;
    launch.set_env(
        "BUTLER_AGENT_HOME",
        sandbox.root.join("agent-home").display().to_string(),
    );
    Ok((sandbox, launch))
}

/// The error code of a failed `--json` command.
pub(crate) fn error_code(output: &CliOutput) -> Result<String, HarnessError> {
    assert_ne!(
        output.code,
        Some(0),
        "expected a failure: {}",
        output.stdout
    );
    let value: Value = output.json()?;
    assert_eq!(value["ok"], false, "{value}");
    Ok(value["error"]["code"]
        .as_str()
        .unwrap_or_default()
        .to_owned())
}

/// The JSON of a command that succeeded.
pub(crate) fn ok(output: &CliOutput) -> Result<Value, HarnessError> {
    assert_eq!(
        output.code,
        Some(0),
        "exit {:?}\nstdout: {}\nstderr: {}",
        output.code,
        output.stdout,
        output.stderr
    );
    output.json()
}
