//! `butler rollback [--to VERSION] [--yes]` and `butler versions`: switch the
//! Agent home back to an installed version, and list what is installed.

use std::io::{IsTerminal, Write};
use std::process::ExitCode;

use butler_runtime::operations::InstalledVersion;
use serde_json::{Value, json};

use super::context::Context;
use super::report::{Output, install_error};
use super::{Options, ResolvedInstallation};
use crate::host::cli::error::CliError;

pub(super) async fn run(installation: ResolvedInstallation, options: &Options) -> ExitCode {
    let out = Output {
        command: "butler rollback",
        json: options.json,
        quiet: options.quiet,
    };
    match rollback(installation, options).await {
        Ok((data, human)) => out.ok(&data, &human),
        Err(error) => out.fail(&error),
    }
}

async fn rollback(
    installation: ResolvedInstallation,
    options: &Options,
) -> Result<(Value, String), CliError> {
    let context = Context::open(installation, options)?;
    let target = context
        .home
        .rollback_target(options.to.as_deref())
        .map_err(|error| install_error(&error))?;
    if options.dry_run {
        let data = json!({"dryRun": true, "target": version_json(&target)});
        let human = format!("would switch to {} ({})", target.version, target.dir);
        return Ok((data, human));
    }
    if !options.yes && !confirmed(&format!("Switch to {} and restart?", target.version)) {
        return Err(CliError::failed("confirmation_required", "rollback needs --yes").with_exit(2));
    }
    let switched = {
        let lock = context.home.lock().map_err(|error| install_error(&error))?;
        lock.activate(&target.dir)
            .map_err(|error| install_error(&error))?
    };
    let before = context.running_record();
    let service = if options.no_restart {
        json!({"wasRunning": null, "restarted": false})
    } else {
        match context.restart_if_running(&target.dir).await {
            Ok(service) => service,
            Err(error) => {
                let up = context
                    .restore(switched.replaced.as_deref(), before.as_ref())
                    .await;
                let message = if up {
                    format!("{}; the previous service is running again", error.message)
                } else {
                    error.message
                };
                return Err(CliError::failed("rollback_restart_failed", message));
            }
        }
    };
    let launchers = context.refresh_launchers();
    let data = json!({
        "active": switched.active,
        "previous": switched.previous,
        "replaced": switched.replaced,
        "changed": switched.changed,
        "launchers": launchers,
        "service": service,
    });
    let human = format!(
        "Butler Agent {} is active{}.",
        target.version,
        super::agent::restart_note(&data["service"])
    );
    Ok((data, human))
}

/// `butler versions [--json]`: the installed versions, the active one marked.
pub(super) fn list(installation: ResolvedInstallation, options: &Options) -> ExitCode {
    let out = Output {
        command: "butler versions",
        json: options.json,
        quiet: options.quiet,
    };
    let result = Context::open(installation, options).and_then(|context| {
        context
            .home
            .versions()
            .map_err(|error| install_error(&error))
            .map(|versions| (context, versions))
    });
    match result {
        Ok((context, versions)) => {
            let data = json!({
                "agentHome": context.home.root(),
                "versions": versions.iter().map(version_json).collect::<Vec<_>>(),
            });
            out.ok(&data, &render(&versions))
        }
        Err(error) => out.fail(&error),
    }
}

fn version_json(version: &InstalledVersion) -> Value {
    json!({
        "version": version.version,
        "dir": version.dir,
        "active": version.active,
        "previous": version.previous,
        "legacy": version.legacy,
    })
}

fn render(versions: &[InstalledVersion]) -> String {
    if versions.is_empty() {
        return "No Butler Agent version is installed here.".into();
    }
    versions
        .iter()
        .map(|version| {
            let mark = match (version.active, version.previous) {
                (true, _) => "* ",
                _ => "  ",
            };
            let role = match (version.active, version.previous) {
                (true, _) => "  active",
                (false, true) => "  previous",
                _ => "",
            };
            format!("{mark}{}  ({}){role}", version.version, version.dir)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Asks on a terminal; anything else (a script, a pipe) must pass `--yes`.
fn confirmed(question: &str) -> bool {
    if !std::io::stdin().is_terminal() {
        return false;
    }
    eprint!("{question} [y/N] ");
    let _ = std::io::stderr().flush();
    let mut answer = String::new();
    std::io::stdin().read_line(&mut answer).is_ok()
        && matches!(answer.trim().to_ascii_lowercase().as_str(), "y" | "yes")
}
