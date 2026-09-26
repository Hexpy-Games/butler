//! Auth and model settings composed through the existing Models owner.

use std::{path::Path, process::ExitCode};

use serde_json::{Value, json};

use super::super::oauth_login;
use super::{CliError, Command, Options, ResolvedInstallation, path, report_error, report_success};
use crate::models;

pub(super) fn auth_status(
    options: &Options,
    command: Command,
    data_root: &Path,
    installation: &ResolvedInstallation,
) -> ExitCode {
    let env_path = data_root.join(".env");
    let environment = match path::read_private_environment(installation, data_root, &env_path) {
        Ok(environment) => environment,
        Err(error) => return report_error(command.name(), options.json, error),
    };
    let mut data = models::auth_status_with_environment(data_root, &environment);
    data["envPath"] = Value::String(env_path.display().to_string());
    data["redacted"] = Value::Bool(true);
    let human = format!(
        "Butler auth\nconfigured: {}\nmode: {}\nsource: {}\nsecrets: redacted",
        data["configured"].as_bool().unwrap_or(false),
        data["mode"].as_str().unwrap_or("missing"),
        data["source"].as_str().unwrap_or("none"),
    );
    report_success(options, command.name(), data, &human)
}

pub(super) async fn auth_login(
    options: Options,
    command: Command,
    data_root: std::path::PathBuf,
    installation: ResolvedInstallation,
) -> ExitCode {
    if options.non_interactive {
        return report_error(
            command.name(),
            options.json,
            CliError::invalid("auth login requires an interactive browser flow"),
        );
    }
    match oauth_login::run_native_oauth_login_for_data(installation, data_root).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => report_error(
            command.name(),
            options.json,
            CliError::failed("auth_login_failed", message),
        ),
    }
}

pub(super) async fn auth_logout(
    options: &Options,
    command: Command,
    data_root: &Path,
    installation: &ResolvedInstallation,
) -> ExitCode {
    if !options.yes && !options.non_interactive {
        return report_error(
            command.name(),
            options.json,
            CliError::invalid("auth logout requires --yes"),
        );
    }
    let environment =
        match path::read_private_environment(installation, data_root, &data_root.join(".env")) {
            Ok(environment) => environment,
            Err(error) => return report_error(command.name(), options.json, error),
        };
    let profile = path::auth_profile_path(data_root, &environment);
    let profile = match path::safe_data_file(installation, data_root, &profile) {
        Ok(path) => path,
        Err(_) => {
            return report_error(
                command.name(),
                options.json,
                CliError::invalid("auth profile removal must remain inside DATA"),
            );
        }
    };
    let owner = match models::open_status_models(data_root.to_path_buf()).await {
        Ok(owner) => owner,
        Err(message) => {
            return report_error(
                command.name(),
                options.json,
                CliError::failed("auth_logout_failed", message),
            );
        }
    };
    let removed = match owner.configuration.remove_auth_profile(&profile).await {
        Ok(removed) => removed,
        Err(message) => {
            return report_error(
                command.name(),
                options.json,
                CliError::failed("auth_logout_failed", message),
            );
        }
    };
    drop(owner);
    let data = json!({
        "removed": removed,
        "profilePath": profile.display().to_string(),
        "envPath": data_root.join(".env").display().to_string(),
        "apiKeyEnvUntouched": true,
        "redacted": true,
    });
    let human = if removed {
        "Local auth profile removed."
    } else {
        "No local auth profile was present."
    };
    report_success(options, command.name(), data, human)
}

pub(super) fn model_list(options: &Options, command: Command) -> ExitCode {
    let refs = models::CLI_FALLBACK_OPENAI_MODELS
        .iter()
        .map(|model| format!("openai/{model}"))
        .collect::<Vec<_>>();
    let data = json!({ "source": "bundled-catalog", "models": refs });
    report_success(options, command.name(), data, &refs.join("\n"))
}

pub(super) async fn model_set(
    options: &Options,
    command: Command,
    data_root: &Path,
    installation: &ResolvedInstallation,
) -> ExitCode {
    let Some(requested) = options.positionals.get(2) else {
        return report_error(
            command.name(),
            options.json,
            CliError::invalid("model set requires <provider/model>"),
        );
    };
    let parsed = models::parse_model_ref(requested);
    if parsed.source != models::ParsedModelRefSource::Namespaced || parsed.model_id.is_empty() {
        return report_error(
            command.name(),
            options.json,
            CliError::invalid("model set requires canonical provider/model ref"),
        );
    }
    if let Err(error) = path::safe_data_file(
        installation,
        data_root,
        &data_root.join("butler.config.json"),
    ) {
        return report_error(command.name(), options.json, error);
    }
    let owner = match models::open_status_models(data_root.to_path_buf()).await {
        Ok(owner) => owner,
        Err(message) => {
            return report_error(
                command.name(),
                options.json,
                CliError::failed("model_set_failed", message),
            );
        }
    };
    let change = match owner.configuration.set_default_model(requested).await {
        Ok(change) => change,
        Err(message) => {
            return report_error(command.name(), options.json, CliError::health(message));
        }
    };
    drop(owner);
    let data = json!({
        "oldModel": change.previous,
        "newModel": change.model.canonical_ref,
        "provider": change.model.provider_id,
        "model": change.model.model_id,
        "restartRecommended": true,
    });
    report_success(
        options,
        command.name(),
        data,
        &format!(
            "Model set to {}. Restart recommended.",
            parsed.canonical_ref
        ),
    )
}
