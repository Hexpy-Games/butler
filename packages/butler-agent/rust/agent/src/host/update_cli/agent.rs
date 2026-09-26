//! Source-shaped Agent update command with DATA-only, user-installed handoff.

use std::process::ExitCode;

use serde_json::{Value, json};

use super::{Options, ResolvedInstallation, settings_cli};
use crate::operations::{AgentArchiveUpdateService, AgentUpdateRequest};

pub(super) async fn run(installation: ResolvedInstallation, options: &Options) -> ExitCode {
    if options.check && options.apply {
        return super::failure(
            options.json,
            "invalid_arguments",
            "update accepts either --check or --apply, not both",
            2,
        );
    }
    let dry_run = options.dry_run;
    let apply = options.apply || dry_run || !options.check;
    if apply && !dry_run && !options.yes {
        return super::failure(
            options.json,
            "confirmation_required",
            "update --apply requires --yes",
            2,
        );
    }
    let data = match settings_cli::resolve_data_root_override(options.data.clone(), &installation) {
        Ok(data) => data,
        Err(_) => {
            return super::failure(options.json, "unsafe_path", "BUTLER_DATA is unavailable", 1);
        }
    };
    let service = match AgentArchiveUpdateService::new(
        data,
        installation.root().to_path_buf(),
        installation.agent_version(),
    ) {
        Ok(service) => service,
        Err(code) => {
            return super::failure(options.json, &code, "Agent updates are unavailable", 1);
        }
    };
    let signal_task = match super::super::memory_maintain::signals(service.cancellation_token()) {
        Ok(task) => task,
        Err(_) => {
            service.close();
            return super::failure(
                options.json,
                "signal_unavailable",
                "Agent update signal handling is unavailable",
                1,
            );
        }
    };
    let request = AgentUpdateRequest {
        manifest: options.manifest.clone(),
        channel: options.channel.clone(),
        dry_run,
    };
    let result = if options.check && !dry_run {
        service.check(&request).await
    } else {
        service.apply(&request).await
    };
    service.close();
    signal_task.abort();
    let _ = signal_task.await;
    match result {
        Ok(value) => {
            let human = render(&value, dry_run);
            if options.json {
                println!(
                    "{}",
                    json!({
                        "ok": true,
                        "command": "butler update",
                        "data": value,
                        "error": null,
                        "privacy": {"rawTextIncluded": false, "secretsIncluded": false}
                    })
                );
            } else if !options.quiet {
                println!("{human}");
            }
            ExitCode::SUCCESS
        }
        Err(code) => super::failure(options.json, &code, "Agent update failed", 1),
    }
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
    if value["stage_status"] == "staged" {
        return format!(
            "Butler Agent update staged: {} -> {}. Install the archive manually to apply it.",
            value["current_version"].as_str().unwrap_or("unknown"),
            value["available_version"].as_str().unwrap_or("unknown"),
        );
    }
    if value["update_available"] == true {
        return format!(
            "Butler Agent update available: {} -> {}.",
            value["current_version"].as_str().unwrap_or("unknown"),
            value["available_version"].as_str().unwrap_or("unknown"),
        );
    }
    format!(
        "Butler Agent is up to date ({}).",
        value["current_version"].as_str().unwrap_or("unknown")
    )
}
