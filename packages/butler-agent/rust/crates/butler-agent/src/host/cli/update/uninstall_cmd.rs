//! `butler uninstall [--keep-data | --purge-data] --yes`: stop the service,
//! unregister login-start, remove the launchers and the Agent home.
//!
//! Only what the CLI installer put in place goes: the Agent home's versions,
//! a login registration that runs a program from the Agent home, and
//! launchers that carry Butler's marker. The App bundle is never touched, nor
//! is a registration or launcher that belongs to it. The data folder stays
//! unless `--purge-data` names it.

use std::path::Path;
use std::process::ExitCode;

use butler_platform::command_launcher::Removal;
use butler_platform::service_registration::{self, Activation};
use butler_platform::user_dirs;
use serde_json::{Value, json};

use super::context::Context;
use super::report::{Output, install_error};
use super::{Options, ResolvedInstallation};
use crate::host::cli::error::CliError;
use crate::host::cli::service;
use crate::host::service::cli_launcher;

pub(super) async fn run(installation: ResolvedInstallation, options: &Options) -> ExitCode {
    let out = Output {
        command: "butler uninstall",
        json: options.json,
        quiet: options.quiet,
    };
    match uninstall(installation, options).await {
        Ok((data, human)) => out.ok(&data, &human),
        Err(error) => out.fail(&error),
    }
}

async fn uninstall(
    installation: ResolvedInstallation,
    options: &Options,
) -> Result<(Value, String), CliError> {
    if options.keep_data && options.purge_data {
        return Err(CliError::invalid("--keep-data and --purge-data conflict"));
    }
    if !options.yes && !options.dry_run {
        return Err(
            CliError::failed("confirmation_required", "uninstall needs --yes").with_exit(2),
        );
    }
    let context = Context::open(installation, options)?;
    if options.purge_data {
        purge_allowed(&context)?;
    }
    if options.dry_run {
        return Ok(plan(&context, options));
    }
    let stopped = stop_service(&context).await?;
    // Deleting the data folder must not race a start: hold the admission lock
    // from here on, and stop if an instance came up meanwhile.
    let _admission = hold_data(&context, options).await?;
    let login_start = unregister_login_start(&context, options);
    let launchers = remove_launchers(&context);
    let removal = context
        .home
        .lock()
        .and_then(butler_runtime::operations::HomeLock::remove_all)
        .map_err(|error| install_error(&error))?;
    let purged = if options.purge_data {
        purge(&context.data_root)?;
        true
    } else {
        false
    };
    let data = json!({
        "serviceStopped": stopped,
        "loginStart": login_start,
        "launchers": launchers,
        "agentHome": {
            "path": context.home.root(),
            "removedVersions": removal.removed,
            "kept": removal.kept,
            "removed": removal.home_removed,
        },
        "data": {"path": context.data_root, "purged": purged},
    });
    let human = format!(
        "Butler Agent uninstalled ({} version{} removed); data {}.",
        removal.removed.len(),
        if removal.removed.len() == 1 { "" } else { "s" },
        if purged { "purged" } else { "kept" },
    );
    Ok((data, human))
}

fn plan(context: &Context, options: &Options) -> (Value, String) {
    let versions = context.home.versions().unwrap_or_default();
    let data = json!({
        "dryRun": true,
        "agentHome": context.home.root(),
        "versions": versions.iter().map(|version| version.dir.clone()).collect::<Vec<_>>(),
        "dataFolder": context.data_root,
        "purgeData": options.purge_data,
    });
    let human = format!(
        "would remove {} version(s) from {}{}",
        versions.len(),
        context.home.root().display(),
        if options.purge_data {
            format!(" and delete {}", context.data_root.display())
        } else {
            String::new()
        }
    );
    (data, human)
}

/// Stops the service if one runs, so no process holds files being removed.
async fn stop_service(context: &Context) -> Result<bool, CliError> {
    match service::running_instance(&context.data_root) {
        Ok(None) => Ok(false),
        Ok(Some(_)) => service::stop_running(context.installation.clone(), &context.data_root)
            .await
            .map(|_| true)
            .map_err(|error| CliError::failed("service_stop_failed", error.message().to_owned())),
        Err(error) => Err(CliError::failed(
            "service_state_unavailable",
            error.message().to_owned(),
        )),
    }
}

/// The DATA admission lock, when the data folder is about to be deleted.
async fn hold_data(
    context: &Context,
    options: &Options,
) -> Result<Option<crate::host::service::instance::AdmissionLock>, CliError> {
    if !options.purge_data || !context.data_root.is_dir() {
        return Ok(None);
    }
    let guard = service::admit(&context.installation, &context.data_root)
        .await
        .map_err(|error| CliError::failed("service_busy", error.message().to_owned()))?;
    if matches!(service::running_instance(&context.data_root), Ok(Some(_))) {
        return Err(CliError::failed(
            "service_running",
            "the service started again; stop it and retry",
        ));
    }
    Ok(Some(guard))
}

/// Unregisters login-start when the registration runs the Agent home's
/// program; the App's own registration stays.
fn unregister_login_start(context: &Context, options: &Options) -> Value {
    let activation = if options.files_only {
        Activation::FilesOnly
    } else {
        Activation::Load
    };
    match service_registration::is_owned_by(context.home.root()) {
        Ok(true) => match service_registration::uninstall(activation) {
            Ok(removal) => json!({"state": "removed", "unloaded": removal.unloaded}),
            Err(error) => json!({"state": "failed", "message": error.to_string()}),
        },
        Ok(false) => json!({"state": "absent-or-not-ours"}),
        Err(error) => json!({"state": "unavailable", "message": error.to_string()}),
    }
}

/// Removes the `butler` command launchers that are Butler's and run the
/// Agent home. A data-folder launcher that runs an App bundle stays.
fn remove_launchers(context: &Context) -> Value {
    let command = match context.home.remove_command_launcher(None) {
        Ok((_, Removal::Removed)) => "removed",
        Ok((_, Removal::Absent)) => "absent",
        Ok((_, Removal::Kept)) => "kept-foreign",
        Err(_) => "failed",
    };
    let launcher = cli_launcher::data_launcher_path(&context.data_root);
    let runs_home = std::fs::read_to_string(&launcher)
        .is_ok_and(|text| text.contains(&context.home.root().to_string_lossy().into_owned()));
    let data_launcher = if runs_home {
        match cli_launcher::remove(&context.data_root) {
            Ok(true) => "removed",
            Ok(false) => "kept-foreign",
            Err(_) => "failed",
        }
    } else {
        "not-ours"
    };
    json!({"command": command, "dataLauncher": data_launcher})
}

/// A data folder is only deleted when it is a real directory of its own:
/// not a link, not the home directory or one of its parents, not a system
/// folder, and not the Agent home or something that contains it.
fn purge_allowed(context: &Context) -> Result<(), CliError> {
    let unsafe_path = |message: &'static str| CliError::failed("unsafe_path", message);
    let path = &context.data_root;
    let metadata = std::fs::symlink_metadata(path);
    if metadata.is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(unsafe_path("the data folder is a symbolic link"));
    }
    let home = user_dirs::home_dir().and_then(|home| home.canonicalize().ok());
    let overlaps_home = home
        .as_ref()
        .is_some_and(|home| path == home || home.starts_with(path));
    let agent_home = context.home.root().canonicalize().ok();
    let overlaps_agent = agent_home
        .as_ref()
        .is_some_and(|agent| path.starts_with(agent) || agent.starts_with(path));
    if overlaps_home || overlaps_agent || user_dirs::is_system_folder(path) {
        return Err(unsafe_path(
            "the data folder is not a folder Butler may delete",
        ));
    }
    Ok(())
}

fn purge(data_root: &Path) -> Result<(), CliError> {
    match std::fs::remove_dir_all(data_root) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(CliError::failed(
            "data_purge_failed",
            "the data folder could not be removed",
        )
        .with_source(error)),
    }
}
