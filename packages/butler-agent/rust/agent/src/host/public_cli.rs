//! Installed native command discovery and version provenance.

use std::{ffi::OsString, path::PathBuf, process::ExitCode};

use serde_json::json;

use super::{ResolvedInstallation, settings_cli};

mod inventory;

#[derive(Clone, Copy)]
enum Action {
    Help,
    Commands,
    Version,
}

pub fn recognizes(args: &[OsString]) -> bool {
    args.iter().any(|arg| arg == "--help" || arg == "-h")
        || first_positionals(args)
            .first()
            .is_some_and(|value| matches!(value.as_str(), "help" | "commands" | "version"))
}

pub async fn run(installation: ResolvedInstallation, args: Vec<OsString>) -> ExitCode {
    let parsed = match parse(&args) {
        Ok(value) => value,
        Err(message) => return error(args.iter().any(|arg| arg == "--json"), &message),
    };
    let command = match parsed.action {
        Action::Help => "butler help",
        Action::Commands => "butler commands",
        Action::Version => "butler version",
    };
    let data = match parsed.action {
        Action::Help => {
            let entries = inventory::selected(&parsed.help_path);
            if entries.is_empty() && !parsed.help_path.is_empty() {
                return error(parsed.json, "unknown native command");
            }
            json!({"usage": inventory::render(&entries), "commands": inventory::values(&entries)})
        }
        Action::Commands => json!({"commands": inventory::values(&inventory::all())}),
        Action::Version => {
            let data_root =
                match settings_cli::resolve_data_root_override(parsed.data, &installation) {
                    Ok(value) => value,
                    Err(message) => return error(parsed.json, &message),
                };
            let provenance = match installation.native_payload_provenance() {
                Ok(value) => value,
                Err(message) => return error(parsed.json, &message),
            };
            let version_available = provenance
                .as_ref()
                .is_some_and(|value| value.agent_version.is_some());
            json!({
                "version": provenance.as_ref().and_then(|value| value.agent_version.as_deref()),
                "appVersion": provenance.as_ref().and_then(|value| value.app_version.as_deref()),
                "runtime": {"kind": "native", "source": "installed_executable"},
                "installation": {
                    "schema": provenance.as_ref().map(|value| value.schema.as_str()),
                    "platform": provenance.as_ref().and_then(|value| value.platform.as_deref()),
                    "architecture": provenance.as_ref().and_then(|value| value.architecture.as_deref()),
                    "binary": provenance.as_ref().and_then(|value| value.binary.as_deref()),
                    "resources": provenance.as_ref().and_then(|value| value.resources.as_deref()),
                    "launcher": provenance.as_ref().and_then(|value| value.launcher.as_deref()),
                    "binarySha256": provenance.as_ref().and_then(|value| value.binary_sha256.as_deref()),
                    "resourcesSha256": provenance.as_ref().and_then(|value| value.resources_sha256.as_deref()),
                },
                "butlerData": data_root,
                "availability": if version_available { "installed_manifest" } else { "unavailable" },
            })
        }
    };
    if parsed.json {
        println!(
            "{}",
            json!({
                "ok": true, "command": command, "data": data, "error": null,
                "privacy": {"rawTextIncluded": false, "secretsIncluded": false}
            })
        );
    } else if !parsed.quiet {
        match parsed.action {
            Action::Help => println!("{}", data["usage"].as_str().unwrap_or("Butler native help")),
            Action::Commands => println!("{}", inventory::render(&inventory::all())),
            Action::Version => println!(
                "Butler native {}",
                data["version"].as_str().unwrap_or("unavailable")
            ),
        }
    }
    ExitCode::SUCCESS
}

struct Parsed {
    action: Action,
    data: Option<PathBuf>,
    help_path: Vec<String>,
    json: bool,
    quiet: bool,
}

fn parse(args: &[OsString]) -> Result<Parsed, String> {
    let mut data = None;
    let mut json = false;
    let mut quiet = false;
    let mut help_flag = false;
    let mut words = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let value = args[index].to_string_lossy();
        match value.as_ref() {
            "--data" => {
                let next = args
                    .get(index + 1)
                    .filter(|next| !next.to_string_lossy().starts_with('-'))
                    .ok_or_else(|| "--data requires a path".to_owned())?;
                data = Some(PathBuf::from(next));
                index += 2;
                continue;
            }
            "--home" => return Err("--home is unsupported for native installation".into()),
            "--json" => json = true,
            "--quiet" | "--silent" => quiet = true,
            "--help" | "-h" => help_flag = true,
            "--verbose" => {}
            option if option.starts_with("--data=") => data = Some(PathBuf::from(&option[7..])),
            option if option.starts_with('-') => {
                return Err(format!("unsupported option: {option}"));
            }
            _ => words.push(value.into_owned()),
        }
        index += 1;
    }
    let (action, help_path) = if help_flag {
        let path = if words.first().is_some_and(|value| value == "help") {
            words[1..].to_vec()
        } else {
            words
        };
        (Action::Help, path)
    } else {
        match words.first().map(String::as_str) {
            Some("help") => (Action::Help, words[1..].to_vec()),
            Some("commands") if words.len() == 1 => (Action::Commands, Vec::new()),
            Some("version") if words.len() == 1 => (Action::Version, Vec::new()),
            _ => return Err("supported commands: help, commands, version".into()),
        }
    };
    Ok(Parsed {
        action,
        data,
        help_path,
        json,
        quiet,
    })
}

fn first_positionals(args: &[OsString]) -> Vec<String> {
    let mut words = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let value = args[index].to_string_lossy();
        if value == "--data" || value == "--home" {
            index += 2;
        } else {
            if !value.starts_with('-') {
                words.push(value.into_owned());
            }
            index += 1;
        }
    }
    words
}

fn error(json_output: bool, message: &str) -> ExitCode {
    if json_output {
        println!(
            "{}",
            json!({
                "ok": false, "command": "butler", "data": null,
                "error": {"code": "invalid_arguments", "message": message},
                "privacy": {"rawTextIncluded": false, "secretsIncluded": false}
            })
        );
    } else {
        eprintln!("{message}");
    }
    ExitCode::from(2)
}
