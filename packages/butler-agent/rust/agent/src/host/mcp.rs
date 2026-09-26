//! Standalone MCP stdio entrypoint; it does not acquire service/runtime ownership.

mod cleanup;
mod graph;
mod model;
mod registry_cli;
mod restart;
mod server;
mod skills;
mod status;
mod stdio;

use std::{ffi::OsString, path::PathBuf, process::ExitCode};

use serde_json::Value;

use super::ResolvedInstallation;

#[derive(Default)]
struct Options {
    data: Option<String>,
    positionals: Vec<String>,
}

pub fn recognizes(args: &[OsString]) -> bool {
    if registry_cli::recognizes(args) {
        return true;
    }
    let mut positionals = Vec::new();
    let mut index = 0;
    while index < args.len() {
        match args[index].to_string_lossy().as_ref() {
            "--data" | "--home" => index += 2,
            "--json" | "--verbose" | "--quiet" | "--silent" | "--yes" | "--non-interactive" => {
                index += 1
            }
            value if value.starts_with('-') => return false,
            command => {
                positionals.push(command.to_owned());
                index += 1;
            }
        }
    }
    positionals.as_slice() == ["mcp", "serve"]
}

pub async fn run(installation: ResolvedInstallation, args: Vec<OsString>) -> ExitCode {
    if registry_cli::recognizes(&args) {
        return registry_cli::run(installation, args).await;
    }
    let options = match parse(&args) {
        Ok(options) => options,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::from(2);
        }
    };
    if options.positionals.as_slice() != ["mcp", "serve"] {
        eprintln!("supported command: mcp serve [--data PATH]");
        return ExitCode::from(2);
    }
    let data_root = match resolve_data_root(options.data.as_deref(), &installation) {
        Ok(path) => path,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::FAILURE;
        }
    };
    let config_path = data_root.join("butler.config.json");
    let data_authority = installation.validate_data_root(&data_root);
    let config_authority = installation.validate_data_root(&config_path);
    if !matches!((data_authority, config_authority), (Ok(data), Ok(config)) if config.starts_with(&data))
    {
        eprintln!("native_path_configuration_invalid");
        return ExitCode::FAILURE;
    }
    let server_name = read_server_name(&config_path);

    let cleanup_installation = installation.clone();
    let cleanup_data = data_root.clone();
    match tokio::task::spawn_blocking(move || {
        cleanup::cleanup_old_tasks(&cleanup_data, &cleanup_installation)
    })
    .await
    {
        Ok(Ok(count)) if count > 0 => {
            eprintln!("MCP startup cleanup removed {count} terminal task(s).")
        }
        Ok(Ok(_)) => {}
        Ok(Err(error)) => eprintln!("MCP startup cleanup unavailable: {error}"),
        Err(error) => eprintln!("MCP startup cleanup unavailable: {error}"),
    }

    match server::serve(installation, data_root, server_name).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("native_mcp_failed: {error}");
            ExitCode::FAILURE
        }
    }
}

fn parse(args: &[OsString]) -> Result<Options, String> {
    let mut options = Options::default();
    let mut index = 0;
    while index < args.len() {
        let value = args[index].to_string_lossy();
        match value.as_ref() {
            "--data" => {
                let path = args
                    .get(index + 1)
                    .filter(|value| !value.to_string_lossy().starts_with('-'))
                    .ok_or_else(|| "--data requires a path".to_owned())?;
                options.data = Some(path.to_string_lossy().into_owned());
                index += 2;
            }
            "--home" => {
                return Err("--home is unsupported; use --data for writable state".into());
            }
            "--json" | "--verbose" | "--quiet" | "--silent" | "--yes" | "--non-interactive" => {
                index += 1
            }
            value if value.starts_with('-') => {
                return Err(format!("unsupported MCP option: {value}"));
            }
            value => {
                options.positionals.push(value.to_owned());
                index += 1;
            }
        }
    }
    Ok(options)
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

fn read_server_name(config_path: &std::path::Path) -> String {
    std::fs::read(config_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|value| {
            value
                .pointer("/system/mcpServerName")?
                .as_str()
                .map(str::to_owned)
        })
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "butler-main".into())
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;

    use super::parse;

    #[test]
    fn parser_keeps_data_explicit_and_rejects_home_alias() {
        let args = ["--data", "~/fixture", "mcp", "serve"]
            .map(OsString::from)
            .to_vec();
        let parsed = parse(&args).unwrap();
        assert_eq!(parsed.data.as_deref(), Some("~/fixture"));
        assert_eq!(parsed.positionals, ["mcp", "serve"]);
        assert!(parse(&[OsString::from("--home"), OsString::from("/tmp")]).is_err());
    }
}
