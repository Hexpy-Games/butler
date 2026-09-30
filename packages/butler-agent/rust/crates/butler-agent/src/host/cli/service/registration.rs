//! `butler startup enable | disable | status`: start the service at login
//! through the host's service manager (launchd, systemd `--user`).
//!
//! The definition runs `service run --detached --if-absent` from the CLI
//! installation (`AGENT_HOME/current`, so an update needs no new
//! definition), or from the running installation when there is none. The
//! manager restarts a crashed service only: an intentional stop exits 0 and
//! stays stopped.

use std::process::ExitCode;

use butler_platform::service_registration::{self, Activation, Definition, Error};
use serde_json::{Value, json};

use super::{Action, Options};
use crate::host::ResolvedInstallation;
use butler_runtime::operations::AgentHome;

pub(super) fn run(
    action: Action,
    installation: &ResolvedInstallation,
    data: Option<&str>,
    options: &Options,
) -> ExitCode {
    let activation = if options.files_only {
        Activation::FilesOnly
    } else {
        Activation::Load
    };
    let result = match action {
        Action::RegisterLogin => install(installation, data, activation),
        Action::UnregisterLogin => uninstall(activation),
        _ => status(),
    };
    match result {
        Ok((value, human)) => {
            if options.json {
                println!(
                    "{}",
                    json!({"ok": true, "command": action.name(), "data": value})
                );
            } else if !options.quiet {
                println!("{human}");
            }
            ExitCode::SUCCESS
        }
        Err(error) => super::report_error(action.name(), options.json, &error.to_string()),
    }
}

fn install(
    installation: &ResolvedInstallation,
    data: Option<&str>,
    activation: Activation,
) -> Result<(Value, String), Error> {
    let data_root = super::lifecycle::resolve_data_root(data, installation).map_err(|error| {
        Error::Manager {
            command: "startup enable".into(),
            message: error.message().to_owned(),
        }
    })?;
    // The job runs the CLI installation through `current`, so an update needs
    // no new definition. It is never pointed at an App bundle or a legacy
    // directory, nor set up next to a service the App supervises.
    let home = AgentHome::resolve().map_err(|error| refused(error.code()))?;
    let paths = home.launcher_target();
    if home.active().ok().flatten().is_none() || !paths.program.is_file() {
        return Err(refused(
            "install the Agent first (butler install --from ARCHIVE)",
        ));
    }
    if super::running_instance(&data_root)
        .ok()
        .flatten()
        .is_some_and(|record| record.app_supervised)
    {
        return Err(refused("the Butler App supervises this service"));
    }
    let data_text = data_root.to_string_lossy().into_owned();
    let mut env = vec![("BUTLER_DATA".to_owned(), data_text.clone())];
    // The service settings this command was run with are the job's.
    env.extend(JOB_SETTINGS.iter().filter_map(|name| {
        let value = std::env::var(name).ok().filter(|value| !value.is_empty())?;
        Some(((*name).to_owned(), value))
    }));
    let definition = Definition {
        program: paths.program,
        args: vec![
            "--installation-root".into(),
            paths.root.to_string_lossy().into_owned(),
            "--resource-root".into(),
            paths.resources.to_string_lossy().into_owned(),
            "service".into(),
            "run".into(),
            "--data".into(),
            data_text,
            "--detached".into(),
            "--if-absent".into(),
        ],
        working_dir: data_root,
        env,
    };
    let registration = service_registration::install(&definition, activation)?;
    let human = format!(
        "Butler service registered with {} ({}){}.",
        registration.manager.name(),
        registration.definition.display(),
        if registration.loaded {
            ""
        } else {
            "; not loaded"
        }
    );
    let value = json!({
        "manager": registration.manager.name(),
        "definition": registration.definition,
        "loaded": registration.loaded,
    });
    Ok((value, human))
}

fn uninstall(activation: Activation) -> Result<(Value, String), Error> {
    let removal = service_registration::uninstall(activation)?;
    let human = if removal.definition_removed {
        "Butler service unregistered.".to_owned()
    } else {
        "Butler service was not registered.".to_owned()
    };
    let value = json!({
        "definitionRemoved": removal.definition_removed,
        "unloaded": removal.unloaded,
    });
    Ok((value, human))
}

fn status() -> Result<(Value, String), Error> {
    let status = service_registration::status()?;
    let human = format!(
        "{}: {}, {}, {}",
        status.manager.name(),
        if status.registered {
            "registered"
        } else {
            "not registered"
        },
        state_word(status.loaded, "loaded", "not loaded"),
        state_word(status.running, "running", "not running"),
    );
    let value = json!({
        "manager": status.manager.name(),
        "definition": status.definition,
        "registered": status.registered,
        "loaded": status.loaded,
        "running": status.running,
    });
    Ok((value, human))
}

fn state_word(state: Option<bool>, yes: &'static str, no: &'static str) -> &'static str {
    match state {
        Some(true) => yes,
        Some(false) => no,
        None => "unknown",
    }
}

/// Settings of the service that `startup enable` records in the job, when
/// they are set: where the gateway listens and where secrets are kept.
const JOB_SETTINGS: [&str; 3] = [
    "BUTLER_APP_SERVER_HOST",
    "BUTLER_APP_SERVER_PORT",
    "BUTLER_SECRET_STORE",
];

/// A refusal to register, worded as an error of the manager call.
fn refused(message: &str) -> Error {
    Error::Manager {
        command: "startup enable".into(),
        message: message.to_owned(),
    }
}
