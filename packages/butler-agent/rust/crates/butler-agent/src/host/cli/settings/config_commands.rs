//! Operator configuration commands and their DATA-scoped persistence.

use std::{path::Path, process::ExitCode};

use serde_json::json;

use super::{
    CliError, Command, Options, config, path::safe_data_file, report_error, report_success,
};
use butler_core::configuration;

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
        Err(error) => {
            return report_error(
                command.name(),
                options.json,
                &CliError::health(error.to_string()),
            );
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

pub(super) async fn config_set(
    options: &Options,
    command: Command,
    data_root: &Path,
    installation: &super::ResolvedInstallation,
) -> ExitCode {
    let (dotted_path, raw_value) = match config_set_input(options) {
        Ok(input) => input,
        Err(error) => return report_error(command.name(), options.json, &error),
    };
    let file = match safe_data_file(installation, data_root, &config_path(data_root)) {
        Ok(path) => path,
        Err(error) => return report_error(command.name(), options.json, &error),
    };
    let _change = match configuration::lock_file_async(&file).await {
        Ok(lock) => lock,
        Err(error) => {
            return report_error(
                command.name(),
                options.json,
                &CliError::failed("config_lock_failed", error.to_string()),
            );
        }
    };
    let mut current = match configuration::read_json_object(&file) {
        Ok(value) => value,
        Err(error) => {
            return report_error(
                command.name(),
                options.json,
                &CliError::health(error.to_string()),
            );
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
    if let Err(error) = configuration::write_json_atomic(&file, &current) {
        return report_error(
            command.name(),
            options.json,
            &CliError::failed("config_write_failed", error.to_string()),
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

fn config_set_input(options: &Options) -> Result<(&str, &str), CliError> {
    let (Some(path), Some(value)) = (options.positionals.get(2), options.positionals.get(3)) else {
        return Err(CliError::invalid("config set requires <path> <value>"));
    };
    if config::is_secret_path(path) {
        return Err(CliError::invalid(
            "secret config values must use domain-specific auth commands",
        ));
    }
    if !config::SAFE_CONFIG_PATHS.contains(&path.as_str()) {
        return Err(CliError::invalid(format!(
            "config path is not writable through CLI: {path}"
        )));
    }
    Ok((path, value))
}
