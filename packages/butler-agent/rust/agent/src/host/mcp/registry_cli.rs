//! One-shot `mcp` registry commands; no provider or runtime startup.

use std::{collections::HashMap, ffi::OsString, path::PathBuf, process::ExitCode, sync::Arc};

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::{
    configuration::ConfigurationWrites,
    mcp_client::{NativeMcpClient, RegistryPathGuard},
};

use super::super::ResolvedInstallation;

mod options;
use options::{CliError, Options, parse, upsert_input, value};

pub(super) fn recognizes(args: &[OsString]) -> bool {
    let mut index = 0;
    while index < args.len() {
        let value = args[index].to_string_lossy();
        match value.as_ref() {
            "--data" | "--home" => index += 2,
            "--json" | "--verbose" | "--quiet" | "--silent" | "--yes" | "--non-interactive" => {
                index += 1
            }
            option if option.starts_with('-') => index += 1,
            "mcp" => {
                let mut after = index + 1;
                while after < args.len() {
                    let next = args[after].to_string_lossy();
                    match next.as_ref() {
                        "--data" | "--home" => after += 2,
                        "--json" | "--verbose" | "--quiet" | "--silent" | "--yes"
                        | "--non-interactive" => after += 1,
                        option if option.starts_with('-') => {
                            if args
                                .get(after + 1)
                                .is_some_and(|value| !value.to_string_lossy().starts_with('-'))
                            {
                                after += 2;
                            } else {
                                after += 1;
                            }
                        }
                        subcommand => return subcommand != "serve",
                    }
                }
                return true;
            }
            _ => return false,
        }
    }
    false
}

pub(super) async fn run(installation: ResolvedInstallation, args: Vec<OsString>) -> ExitCode {
    let parsed = match parse(&args) {
        Ok(parsed) => parsed,
        Err(error) => return report_error(&args, error),
    };
    let subcommand = parsed
        .positionals
        .get(1)
        .map(String::as_str)
        .unwrap_or("list");
    if (subcommand == "delete" || subcommand == "remove") && !parsed.yes && !parsed.non_interactive
    {
        return report_error(&args, CliError::invalid("mcp delete requires --yes"));
    }
    let id = parsed
        .positionals
        .get(2)
        .cloned()
        .or_else(|| value(&parsed, "--id"));
    if matches!(
        subcommand,
        "enable" | "disable" | "delete" | "remove" | "test" | "probe"
    ) && id.as_deref().is_none_or(str::is_empty)
    {
        return report_error(
            &args,
            CliError::invalid(format!("mcp {subcommand} requires <id>")),
        );
    }
    let data_root = match resolve_data_root(parsed.data.as_deref(), &installation) {
        Ok(path) => path,
        Err(message) => {
            return report_error(
                &args,
                CliError::failed("native_settings_cli_failed", message, 1),
            );
        }
    };
    let client = match registry_client(data_root, installation) {
        Ok(client) => client,
        Err(message) => {
            return report_error(
                &args,
                CliError::failed("private_environment_unavailable", message, 1),
            );
        }
    };
    match subcommand {
        "list" => match client.list_servers() {
            Ok(data) => report_success(&parsed, "butler mcp list", data.clone(), list_text(&data)),
            Err(message) => report_error(
                &args,
                CliError::failed("native_settings_cli_failed", message, 1),
            ),
        },
        "add" | "set" => {
            let id = value(&parsed, "--id").or_else(|| parsed.positionals.get(2).cloned());
            let Some(id) = id.filter(|value| !value.trim().is_empty()) else {
                return report_error(&args, CliError::invalid("mcp add requires --id <id>"));
            };
            let input = match upsert_input(&parsed, id) {
                Ok(input) => input,
                Err(message) => return report_error(&args, CliError::invalid(message)),
            };
            match client.upsert_server(input).await {
                Ok(server) => report_success(
                    &parsed,
                    "butler mcp add",
                    json!({"server": server, "redacted": true}),
                    format!(
                        "MCP server saved: {} ({}).",
                        server["id"].as_str().unwrap_or(""),
                        server["transport"].as_str().unwrap_or("stdio")
                    ),
                ),
                Err(message) => report_error(&args, CliError::invalid(message)),
            }
        }
        "enable" | "disable" => {
            let enabled = subcommand == "enable";
            match client.set_server_enabled(id.unwrap(), enabled).await {
                Ok(server) => report_success(
                    &parsed,
                    if enabled {
                        "butler mcp enable"
                    } else {
                        "butler mcp disable"
                    },
                    json!({"server": server}),
                    format!(
                        "MCP server {}: {}.",
                        if enabled { "enabled" } else { "disabled" },
                        server["id"].as_str().unwrap_or("")
                    ),
                ),
                Err(message) => report_error(&args, CliError::failed("not_found", message, 1)),
            }
        }
        "delete" | "remove" => match client.delete_server(id.unwrap()).await {
            Ok(data) => {
                let human = if data["removed"] == true {
                    format!("MCP server deleted: {}.", data["id"].as_str().unwrap_or(""))
                } else {
                    format!(
                        "MCP server not found: {}.",
                        data["id"].as_str().unwrap_or("")
                    )
                };
                report_success(&parsed, "butler mcp delete", data, human)
            }
            Err(message) => report_error(
                &args,
                CliError::failed("native_settings_cli_failed", message, 1),
            ),
        },
        "test" | "probe" => {
            let result = client
                .probe_server(&id.unwrap(), &CancellationToken::new())
                .await;
            let server = match result {
                Ok(server) => server,
                Err(error) => return report_probe_failure(&parsed, error.message),
            };
            if server["ok"] != true {
                let message = server["error"]
                    .as_str()
                    .unwrap_or("MCP server probe failed.")
                    .to_owned();
                return report_probe_failure(&parsed, &message);
            }
            let text = format!(
                "MCP server reachable: {}\ntools={} resources={} templates={}",
                server["id"].as_str().unwrap_or(""),
                server["tools"].as_array().map_or(0, Vec::len),
                server["resources"].as_array().map_or(0, Vec::len),
                server["resource_templates"].as_array().map_or(0, Vec::len),
            );
            report_success(&parsed, "butler mcp test", json!({"server": server}), text)
        }
        _ => report_error(
            &args,
            CliError::failed(
                "unknown_command",
                format!("unknown mcp command: {subcommand}"),
                2,
            ),
        ),
    }
}

fn registry_client(
    data_root: PathBuf,
    installation: ResolvedInstallation,
) -> Result<NativeMcpClient, String> {
    let install_root = installation.root().to_path_buf();
    let guard_installation = installation.clone();
    let guard: Arc<RegistryPathGuard> = Arc::new(move |root, target| {
        let root_real = super::super::installation::realpath_or_nearest(root)
            .map_err(|_| "MCP registry DATA path is unavailable.".to_owned())?;
        let target_real = super::super::installation::realpath_or_nearest(target)
            .map_err(|_| "MCP registry path is unavailable.".to_owned())?;
        if !target_real.starts_with(&root_real) {
            return Err("MCP registry path escapes DATA.".into());
        }
        if root_real.starts_with(&install_root)
            || install_root.starts_with(&root_real)
            || target_real.starts_with(&install_root)
        {
            return Err("MCP registry path overlaps the installation.".into());
        }
        guard_installation.validate_data_root(target)?;
        Ok(())
    });
    let mut environment = std::env::vars().collect::<HashMap<_, _>>();
    let private_env = data_root.join(".env");
    let private_env_real = super::super::installation::realpath_or_nearest(&private_env)
        .map_err(|_| "Private environment could not be read.".to_owned())?;
    let data_real = super::super::installation::realpath_or_nearest(&data_root)
        .map_err(|_| "DATA path is unavailable.".to_owned())?;
    installation.validate_data_root(&private_env)?;
    if !private_env_real.starts_with(&data_real) {
        return Err("Private environment must remain inside DATA.".into());
    }
    match std::fs::read_to_string(&private_env) {
        Ok(contents) => {
            for line in contents.lines() {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') {
                    continue;
                }
                let Some((key, raw)) = line.split_once('=') else {
                    continue;
                };
                let key = key.trim();
                if key.is_empty() {
                    continue;
                }
                let mut value = raw.trim();
                if value.len() >= 2
                    && ((value.starts_with('"') && value.ends_with('"'))
                        || (value.starts_with('\'') && value.ends_with('\'')))
                {
                    value = &value[1..value.len() - 1];
                }
                if environment.get(key).is_none_or(String::is_empty) {
                    environment.insert(key.to_owned(), value.to_owned());
                }
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("Private environment could not be read.".into()),
    }
    Ok(NativeMcpClient::with_registry_writer(
        data_root,
        environment,
        Arc::new(ConfigurationWrites::new()),
        guard,
    ))
}

fn resolve_data_root(
    explicit: Option<&str>,
    installation: &ResolvedInstallation,
) -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| "native_home_unavailable".to_owned())?;
    let input = explicit
        .map(str::to_owned)
        .or_else(|| {
            std::env::var_os("BUTLER_DATA")
                .filter(|value| !value.is_empty())
                .map(|value| value.to_string_lossy().into_owned())
        })
        .unwrap_or_else(|| home.join(".butler").to_string_lossy().into_owned());
    let requested = if input == "~" {
        home
    } else if let Some(suffix) = input.strip_prefix("~/") {
        home.join(suffix)
    } else {
        PathBuf::from(input)
    };
    installation.validate_data_root(&requested)
}

fn list_text(data: &Value) -> String {
    let servers = data
        .get("servers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if servers.is_empty() {
        return "No MCP servers configured.".into();
    }
    servers
        .iter()
        .map(|server| {
            let id = server["id"].as_str().unwrap_or("");
            let enabled = if server["enabled"] == true {
                "enabled"
            } else {
                "disabled"
            };
            let transport = server["transport"].as_str().unwrap_or("stdio");
            let target = if transport == "stdio" {
                std::iter::once(server["command"].as_str().unwrap_or(""))
                    .chain(
                        server["args"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(Value::as_str),
                    )
                    .filter(|value| !value.is_empty())
                    .collect::<Vec<_>>()
                    .join(" ")
            } else {
                server["url"].as_str().unwrap_or("").to_owned()
            };
            format!("{id}: {enabled} {transport} {target}")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn report_success(options: &Options, command: &str, data: Value, human: String) -> ExitCode {
    if options.json {
        println!(
            "{}",
            json!({
                "ok": true,
                "command": command,
                "data": data,
                "error": null,
                "privacy": {"rawTextIncluded": false, "secretsIncluded": false},
            })
        );
    } else if !options.quiet {
        println!("{}", human.trim_end());
    }
    ExitCode::SUCCESS
}

fn report_error(args: &[OsString], error: CliError) -> ExitCode {
    report_error_as(args, &command_name(args), error)
}

fn report_error_as(args: &[OsString], command: &str, error: CliError) -> ExitCode {
    let json_requested = args.iter().any(|arg| arg == "--json");
    if json_requested {
        println!(
            "{}",
            json!({
                "ok": false,
                "command": command,
                "data": null,
                "error": {"code": error.code, "message": error.message},
                "privacy": {"rawTextIncluded": false, "secretsIncluded": false},
            })
        );
    } else {
        eprintln!("{}", error.message);
    }
    ExitCode::from(error.exit)
}

fn report_probe_failure(options: &Options, message: &str) -> ExitCode {
    if options.json {
        println!(
            "{}",
            json!({
                "ok": false,
                "command": "butler mcp test",
                "data": null,
                "error": {"code": "external_unavailable", "message": message},
                "privacy": {"rawTextIncluded": false, "secretsIncluded": false},
            })
        );
    } else {
        eprintln!("MCP server probe failed: {message}");
    }
    ExitCode::from(5)
}

fn command_name(args: &[OsString]) -> String {
    let mut positionals = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let value = args[index].to_string_lossy();
        match value.as_ref() {
            "--data" | "--home" => index += 2,
            "--json" | "--quiet" | "--silent" | "--verbose" | "--yes" | "--non-interactive" => {
                index += 1
            }
            option if option.starts_with('-') => index += 1,
            _ => {
                positionals.push(value.into_owned());
                index += 1;
            }
        }
    }
    if positionals.len() < 2 {
        "butler mcp list".into()
    } else {
        format!("butler {}", positionals.join(" "))
    }
}
