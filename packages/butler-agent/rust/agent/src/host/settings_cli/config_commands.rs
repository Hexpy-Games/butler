//! Operator configuration commands and their DATA-scoped persistence.

use std::{
    path::Path,
    process::{Command as ProcessCommand, ExitCode},
};

use serde_json::json;

use super::{
    CliError, Command, Options, config, path::safe_data_file, report_error, report_success,
};
use crate::configuration;

fn config_path(data_root: &Path) -> std::path::PathBuf {
    data_root.join("butler.config.json")
}

pub(super) fn config_get(
    options: &Options,
    command: Command,
    data_root: &Path,
    installation: &super::ResolvedInstallation,
) -> ExitCode {
    let Some(path) = options.positionals.get(2) else {
        return report_error(
            command.name(),
            options.json,
            &CliError::invalid("config get requires <path>"),
        );
    };
    let file = match safe_data_file(installation, data_root, &config_path(data_root)) {
        Ok(path) => path,
        Err(error) => return report_error(command.name(), options.json, &error),
    };
    let current = match configuration::read_json_object(&file) {
        Ok(value) => value,
        Err(message) => {
            return report_error(command.name(), options.json, &CliError::health(message));
        }
    };
    let value = config::value_at_path(&current, path);
    let (data, human) = if config::is_secret_path(path) {
        (
            json!({ "path": path, "redacted": true, "exists": value.is_some() }),
            format!("{path}: [redacted]"),
        )
    } else {
        let projected = config::safe_value(value);
        let human = if value.is_some() {
            config::human_value(Some(&projected))
        } else {
            "(missing)".into()
        };
        (
            json!({ "path": path, "exists": value.is_some(), "value": projected }),
            format!("{path}: {human}"),
        )
    };
    report_success(options, command.name(), &data, &human)
}

pub(super) fn config_set(
    options: &Options,
    command: Command,
    data_root: &Path,
    installation: &super::ResolvedInstallation,
) -> ExitCode {
    let (Some(dotted_path), Some(raw_value)) =
        (options.positionals.get(2), options.positionals.get(3))
    else {
        return report_error(
            command.name(),
            options.json,
            &CliError::invalid("config set requires <path> <value>"),
        );
    };
    if config::is_secret_path(dotted_path) {
        return report_error(
            command.name(),
            options.json,
            &CliError::invalid("secret config values must use domain-specific auth commands"),
        );
    }
    if !config::SAFE_CONFIG_PATHS.contains(&dotted_path.as_str()) {
        return report_error(
            command.name(),
            options.json,
            &CliError::invalid(format!(
                "config path is not writable through CLI: {dotted_path}"
            )),
        );
    }
    let file = match safe_data_file(installation, data_root, &config_path(data_root)) {
        Ok(path) => path,
        Err(error) => return report_error(command.name(), options.json, &error),
    };
    let mut current = match configuration::read_json_object(&file) {
        Ok(value) => value,
        Err(message) => {
            return report_error(command.name(), options.json, &CliError::health(message));
        }
    };
    let previous = config::value_at_path(&current, dotted_path).cloned();
    let value = config::parse_value(raw_value);
    config::set_path(&mut current, dotted_path, value.clone());
    let validation = config::validate(&current);
    if !validation.errors.is_empty() {
        return report_error(
            command.name(),
            options.json,
            &CliError::health(validation.errors.join("; ")),
        );
    }
    if let Err(message) = configuration::write_json_atomic(&file, &current) {
        return report_error(
            command.name(),
            options.json,
            &CliError::failed("config_write_failed", message),
        );
    }
    let data = json!({
        "path": dotted_path,
        "oldValue": config::safe_value(previous.as_ref()),
        "newValue": config::safe_value(Some(&value)),
        "warnings": validation.warnings,
        "configPath": file.display().to_string(),
    });
    report_success(
        options,
        command.name(),
        &data,
        &format!("Updated {dotted_path}."),
    )
}

pub(super) fn config_validate(
    options: &Options,
    command: Command,
    data_root: &Path,
    installation: &super::ResolvedInstallation,
) -> ExitCode {
    let file = match safe_data_file(installation, data_root, &config_path(data_root)) {
        Ok(path) => path,
        Err(error) => return report_error(command.name(), options.json, &error),
    };
    let current = match configuration::read_json_object(&file) {
        Ok(value) => value,
        Err(message) => {
            return report_error(command.name(), options.json, &CliError::health(message));
        }
    };
    let validation = config::validate(&current);
    if !validation.errors.is_empty() {
        let message = validation.errors.join("; ");
        if options.json {
            println!(
                "{}",
                json!({
                    "ok": false,
                    "command": command.name(),
                    "data": {
                        "ok": false,
                        "configPath": file.display().to_string(),
                        "errors": validation.errors,
                        "warnings": validation.warnings,
                        "redacted": true,
                    },
                    "error": { "code": "health_failed", "message": message },
                    "privacy": { "rawTextIncluded": false, "secretsIncluded": false },
                })
            );
        } else {
            eprintln!("Config invalid: {message}");
        }
        return ExitCode::from(3);
    }
    let data = json!({
        "ok": true,
        "configPath": file.display().to_string(),
        "errors": validation.errors,
        "warnings": validation.warnings,
        "redacted": true,
    });
    report_success(
        options,
        command.name(),
        &data,
        &format!("Config valid. warnings={}", validation.warnings.len()),
    )
}

pub(super) fn config_edit(
    options: &Options,
    command: Command,
    data_root: &Path,
    installation: &super::ResolvedInstallation,
) -> ExitCode {
    if options.non_interactive {
        return report_error(
            command.name(),
            options.json,
            &CliError::invalid("config edit requires an interactive editor"),
        );
    }
    let file = match safe_data_file(installation, data_root, &config_path(data_root)) {
        Ok(path) => path,
        Err(error) => return report_error(command.name(), options.json, &error),
    };
    if let Err(message) = ensure_config_exists(&file) {
        return report_error(
            command.name(),
            options.json,
            &CliError::failed("config_write_failed", message),
        );
    }
    let editor = std::env::var("EDITOR")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "vi".into());
    let Ok(status) = ProcessCommand::new(editor).arg(&file).status() else {
        return ExitCode::FAILURE;
    };
    if !status.success() {
        return ExitCode::from(u8::try_from(status.code().unwrap_or(1)).unwrap_or(1));
    }
    if let Err(error) = safe_data_file(installation, data_root, &file) {
        return report_error(command.name(), options.json, &error);
    }
    let current = match configuration::read_json_object(&file) {
        Ok(value) => value,
        Err(message) => {
            return report_error(command.name(), options.json, &CliError::health(message));
        }
    };
    let validation = config::validate(&current);
    if !validation.errors.is_empty() {
        return report_error(
            command.name(),
            options.json,
            &CliError::health(format!(
                "Config invalid after edit: {}",
                validation.errors.join("; ")
            )),
        );
    }
    report_success(
        options,
        command.name(),
        &json!({ "configPath": file.display().to_string(), "warnings": validation.warnings }),
        &format!("Config edited and validated: {}", file.display()),
    )
}

fn ensure_config_exists(path: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            configuration::write_json_atomic(path, &json!({}))
        }
        Err(_) => Err("Config file could not be inspected.".into()),
    }
}
