//! `butler update`: check for a newer Agent, and with `--apply --yes` install
//! it, switch `current` to it and restart the service on it.
//!
//! The archive for this platform is downloaded and verified, extracted into
//! `AGENT_HOME/<version>-<sha8>` and activated under the Agent home's lock;
//! the previous version stays for `butler rollback`. A service that was
//! running is restarted with the stop-intent `restart` contract by the new
//! binary; when that fails, the previous version is restored and started
//! again.

use std::process::ExitCode;

use butler_runtime::operations::{AgentArchiveUpdateService, AgentUpdateRequest};
use serde_json::{Value, json};

use super::context::Context;
use super::report::{Output, install_error};
use super::{Options, ResolvedInstallation};
use crate::host::cli::error::CliError;

pub(super) async fn run(installation: ResolvedInstallation, options: &Options) -> ExitCode {
    let out = Output {
        command: "butler update",
        json: options.json,
        quiet: options.quiet,
    };
    match execute(installation, options).await {
        Ok((value, human)) => out.ok(&value, &human),
        Err(error) => out.fail(&error),
    }
}

async fn execute(
    installation: ResolvedInstallation,
    options: &Options,
) -> Result<(Value, String), CliError> {
    if options.check && options.apply {
        return Err(CliError::invalid(
            "update accepts either --check or --apply, not both",
        ));
    }
    let dry_run = options.dry_run;
    let apply = options.apply || dry_run || !options.check;
    if apply && !dry_run && !options.yes {
        return Err(
            CliError::failed("confirmation_required", "update --apply requires --yes").with_exit(2),
        );
    }
    let context = Context::open(installation, options)?;
    let mut value = run_service(&context, options).await?;
    if value["restart_required"] == true {
        finish_activation(&context, &mut value, options).await?;
    }
    let human = render(&value, dry_run);
    Ok((value, human))
}

/// Checks, or applies up to and including the switch of `current`.
async fn run_service(context: &Context, options: &Options) -> Result<Value, CliError> {
    let service = AgentArchiveUpdateService::new(
        context.data_root.clone(),
        context.installation.root().to_path_buf(),
        context.known_version(),
    )
    .map_err(|error| install_error(&error))?
    .with_home(context.home.clone());
    let Ok(signal_task) = crate::host::memory_jobs::maintain::signals(service.cancellation_token())
    else {
        service.close();
        return Err(CliError::failed(
            "signal_unavailable",
            "Agent update signal handling is unavailable",
        ));
    };
    let request = AgentUpdateRequest {
        manifest: options.manifest.clone(),
        channel: options.channel.clone(),
        dry_run: options.dry_run,
        protected: context.protected_executables(),
    };
    let result = if options.check && !options.dry_run {
        service.check(&request).await
    } else {
        Box::pin(service.apply(&request)).await
    };
    service.close();
    signal_task.abort();
    let _ = signal_task.await;
    result.map_err(|error| install_error(&error))
}

/// After the switch: launchers, then the service. A restart that fails
/// restores the previous version.
async fn finish_activation(
    context: &Context,
    value: &mut Value,
    options: &Options,
) -> Result<(), CliError> {
    let dir = value["installed"]["dir"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    value["launchers"] = context.refresh_launchers();
    if options.no_restart {
        value["service"] = json!({"wasRunning": null, "restarted": false});
        return Ok(());
    }
    match context.restart_if_running(&dir).await {
        Ok(service) => {
            value["service"] = service;
            Ok(())
        }
        Err(error) => {
            let previous = value["installed"]["replaced"].as_str().map(str::to_owned);
            let message = match previous {
                Some(previous) if restore(context, &previous).await => {
                    format!("{}; restored {previous}", error.message)
                }
                _ => error.message.clone(),
            };
            Err(CliError::failed("update_restart_failed", message))
        }
    }
}

/// Switches back to `previous` and brings the service up on it.
async fn restore(context: &Context, previous: &str) -> bool {
    let switched = context
        .home
        .lock()
        .and_then(|lock| lock.activate(previous))
        .is_ok();
    if !switched {
        return false;
    }
    context.refresh_launchers();
    context.ensure_running(previous).await.is_ok()
}

fn render(value: &Value, dry_run: bool) -> String {
    if dry_run {
        return value["planned_actions"]
            .as_array()
            .map(|actions| {
                actions
                    .iter()
                    .filter_map(Value::as_str)
                    .map(|action| format!("would {action}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();
    }
    let versions = format!(
        "{} -> {}",
        value["current_version"].as_str().unwrap_or("unknown"),
        value["available_version"].as_str().unwrap_or("unknown"),
    );
    if value["activation_status"] == "activated" {
        let restarted = if value["service"]["restarted"] == true {
            " and restarted"
        } else {
            ""
        };
        return format!("Butler Agent updated: {versions}{restarted}.");
    }
    if value["stage_status"] == "staged" {
        return format!("Butler Agent update staged: {versions}.");
    }
    if value["update_available"] == true {
        return format!("Butler Agent update available: {versions}.");
    }
    format!(
        "Butler Agent is up to date ({}).",
        value["current_version"].as_str().unwrap_or("unknown")
    )
}
