//! Internal package startup-task child mode, before installation resolution.

use std::{ffi::OsString, process::ExitCode};

pub(super) async fn run(args: &[OsString]) -> ExitCode {
    let enabled = match args {
        [] => None,
        [arg] if arg == "enable" => Some(true),
        [arg] if arg == "disable" => Some(false),
        _ => {
            eprintln!("usage: butler-agent --package-startup-task [enable|disable]");
            return ExitCode::from(2);
        }
    };
    let result = tokio::task::spawn_blocking(move || match enabled {
        Some(enabled) => butler_platform::startup_task::set(enabled),
        None => butler_platform::startup_task::state(),
    })
    .await
    .map_err(|error| error.to_string())
    .and_then(|result| result);
    match result {
        Ok(state) => {
            println!("{}", serde_json::json!({"state": state.as_str()}));
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("package_startup_task_unavailable: {error}");
            ExitCode::FAILURE
        }
    }
}
