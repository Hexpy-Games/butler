//! One-shot public web diagnostics and page-read commands.

#[cfg(test)]
#[path = "web_access_cli_tests.rs"]
mod tests;

use std::{env, ffi::OsString, path::PathBuf, process::ExitCode, sync::Arc};

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::{NativeProcessEnvironment, NativeProcessModels, ResolvedInstallation};

#[derive(Default, Debug)]
struct Options {
    data: Option<PathBuf>,
    json: bool,
    quiet: bool,
    positionals: Vec<String>,
}

#[derive(Clone, Copy, Debug)]
enum Command {
    SearchStatus,
    SearchTest,
    WebRead,
}

impl Command {
    fn source_name(self) -> &'static str {
        match self {
            Self::SearchStatus => "butler search status",
            Self::SearchTest => "butler search test",
            Self::WebRead => "butler web read",
        }
    }
}

pub fn recognizes(args: &[OsString]) -> bool {
    positionals_without_options(args)
        .first()
        .is_some_and(|value| matches!(value.as_str(), "search" | "web"))
}

pub async fn run(installation: ResolvedInstallation, args: Vec<OsString>) -> ExitCode {
    let json_requested = args.iter().any(|arg| arg == "--json");
    let (options, command) = match parse(&args) {
        Ok((options, Some(command))) => (options, command),
        Ok((_, None)) => {
            return report_error(
                "butler web",
                json_requested,
                "invalid_arguments",
                "supported commands: search status|test <query>, web read <url>",
                2,
            );
        }
        Err(message) => {
            let command = command_name(&args);
            return report_error(command, json_requested, "invalid_arguments", &message, 2);
        }
    };
    let data_root = match super::settings_cli::resolve_data_root_override(
        options.data.clone(),
        &installation,
    ) {
        Ok(path) => path,
        Err(message) => {
            return report_error(
                command.source_name(),
                options.json,
                "unsafe_path",
                &message,
                1,
            );
        }
    };
    let metrics = Arc::new(crate::operations::WebSearchMetrics::new(data_root.clone()));
    let access = match crate::web_access::WebAccess::new_reader(data_root.clone(), metrics.clone())
    {
        Ok(access) => access,
        Err(error) => {
            return report_error(
                command.source_name(),
                options.json,
                error.code,
                &error.message,
                1,
            );
        }
    };
    match command {
        Command::SearchStatus => match access.search_status() {
            Ok(data) => {
                let human = format!(
                    "provider={}\neffective={}\nreader={}\nrequests={}",
                    data["provider"].as_str().unwrap_or("unknown"),
                    data["providerEffective"].as_str().unwrap_or("unknown"),
                    data["readerBackend"].as_str().unwrap_or("unknown"),
                    data["metrics"]["requestCount"].as_u64().unwrap_or(0),
                );
                report_success(&options, command.source_name(), &data, &human);
                ExitCode::SUCCESS
            }
            Err(error) => report_error(
                command.source_name(),
                options.json,
                error.code,
                &error.message,
                1,
            ),
        },
        Command::SearchTest => run_search_test(options, command, data_root, metrics).await,
        Command::WebRead => {
            let requested_url = &options.positionals[2];
            match access
                .read_cli(requested_url, &CancellationToken::new())
                .await
            {
                Ok(data) => {
                    let human = format!(
                        "reader={} ok={} status={}\ntitle={}\nwarnings={}\n{}",
                        data["reader"].as_str().unwrap_or("unknown"),
                        data["ok"],
                        data["status"]
                            .as_u64()
                            .map_or_else(|| "unknown".into(), |n| n.to_string()),
                        data["title"].as_str().unwrap_or("unknown"),
                        data["warnings"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join(", "),
                        data["preview"].as_str().unwrap_or(""),
                    );
                    report_success(&options, command.source_name(), &data, &human);
                    ExitCode::SUCCESS
                }
                Err(error) => {
                    let exit = if error.code == "invalid_arguments" {
                        2
                    } else {
                        1
                    };
                    report_error(
                        command.source_name(),
                        options.json,
                        error.code,
                        &error.message,
                        exit,
                    )
                }
            }
        }
    }
}

async fn run_search_test(
    options: Options,
    command: Command,
    data_root: PathBuf,
    metrics: Arc<crate::operations::WebSearchMetrics>,
) -> ExitCode {
    let home = env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| data_root.clone());
    let os_release = match nix::sys::utsname::uname() {
        Ok(value) => value.release().to_string_lossy().into_owned(),
        Err(_) => "unknown".into(),
    };
    let environment = NativeProcessEnvironment::capture(&data_root, &home, &os_release);
    let collation = match crate::locale::LocaleCollation::new("en-US") {
        Ok(value) => Arc::new(value),
        Err(_) => {
            return report_error(
                command.source_name(),
                options.json,
                "native_locale_unavailable",
                "Native locale is unavailable.",
                1,
            );
        }
    };
    let models = match NativeProcessModels::new(
        data_root.clone(),
        environment.model,
        Arc::new(crate::configuration::ConfigurationWrites::new()),
        collation,
    ) {
        Ok(models) => models,
        Err(_) => {
            return report_error(
                command.source_name(),
                options.json,
                "web_search_provider_auth_missing",
                "Web search provider authentication is unavailable.",
                5,
            );
        }
    };
    let access =
        match crate::web_access::WebAccess::new_search(data_root, models.configuration, metrics) {
            Ok(access) => access,
            Err(error) => {
                return report_error(
                    command.source_name(),
                    options.json,
                    error.code,
                    &error.message,
                    5,
                );
            }
        };
    let query = options.positionals[2..].join(" ").trim().to_owned();
    match access.search_test(&query, &CancellationToken::new()).await {
        Ok(data) => {
            let human = data["results"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|result| {
                    format!(
                        "{} — {}",
                        result["title"].as_str().unwrap_or(""),
                        result["source"].as_str().unwrap_or("")
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
            report_success(
                &options,
                command.source_name(),
                &data,
                if human.is_empty() {
                    "Search completed with no results."
                } else {
                    &human
                },
            );
            ExitCode::SUCCESS
        }
        Err(error) => report_error(
            command.source_name(),
            options.json,
            "external_unavailable",
            &error.message,
            5,
        ),
    }
}

fn parse(args: &[OsString]) -> Result<(Options, Option<Command>), String> {
    let mut options = Options::default();
    let mut index = 0;
    while index < args.len() {
        let value = args[index].to_string_lossy();
        match value.as_ref() {
            "--data" => {
                let path = required_value(args, index, "--data")?;
                options.data = Some(PathBuf::from(path));
                index += 2;
            }
            "--home" => return Err("--home is unsupported; use --data for writable state".into()),
            "--json" => {
                options.json = true;
                index += 1;
            }
            "--quiet" | "--silent" => {
                options.quiet = true;
                index += 1;
            }
            "--verbose" | "--yes" | "--non-interactive" => index += 1,
            value if value.starts_with('-') => return Err(format!("unsupported option: {value}")),
            _ => {
                options.positionals.push(value.into_owned());
                index += 1;
            }
        }
    }
    let command = match options.positionals.as_slice() {
        [family, action] if family == "search" && action == "status" => Some(Command::SearchStatus),
        [family, action, query @ ..]
            if family == "search" && action == "test" && !query.is_empty() =>
        {
            Some(Command::SearchTest)
        }
        [family, action, url] if family == "web" && action == "read" && !url.is_empty() => {
            Some(Command::WebRead)
        }
        _ => None,
    };
    if options
        .positionals
        .first()
        .is_some_and(|value| value == "search")
        && options
            .positionals
            .get(1)
            .is_some_and(|value| value == "test")
        && options.positionals.len() < 3
    {
        return Err("search test requires <query>".into());
    }
    if options
        .positionals
        .first()
        .is_some_and(|value| value == "web")
        && options
            .positionals
            .get(1)
            .is_some_and(|value| value == "read")
        && options.positionals.len() < 3
    {
        return Err("web read requires <url>".into());
    }
    Ok((options, command))
}

fn required_value<'a>(
    args: &'a [OsString],
    index: usize,
    name: &str,
) -> Result<&'a OsString, String> {
    args.get(index + 1)
        .filter(|value| !value.to_string_lossy().starts_with("--"))
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{name} requires a value"))
}

fn positionals_without_options(args: &[OsString]) -> Vec<String> {
    let mut values = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let value = args[index].to_string_lossy();
        match value.as_ref() {
            "--data" => index += 2,
            "--json" | "--quiet" | "--silent" | "--verbose" | "--yes" | "--non-interactive" => {
                index += 1;
            }
            value if value.starts_with('-') => return values,
            _ => {
                values.push(value.into_owned());
                index += 1;
            }
        }
    }
    values
}

fn command_name(args: &[OsString]) -> &'static str {
    match positionals_without_options(args).as_slice() {
        [family, action, ..] if family == "search" && action == "status" => "butler search status",
        [family, action, ..] if family == "search" && action == "test" => "butler search test",
        [family, action, ..] if family == "web" && action == "read" => "butler web read",
        _ => "butler web",
    }
}

fn report_success(options: &Options, command: &str, data: &Value, human: &str) {
    if options.json {
        println!(
            "{}",
            json!({
                "ok": true, "command": command, "data": data, "error": null,
                "privacy": { "rawTextIncluded": false, "secretsIncluded": false },
            })
        );
    } else if !options.quiet {
        println!("{human}");
    }
}

fn report_error(command: &str, json_output: bool, code: &str, message: &str, exit: u8) -> ExitCode {
    if json_output {
        println!(
            "{}",
            json!({
                "ok": false, "command": command, "data": null,
                "error": { "code": code, "message": message },
                "privacy": { "rawTextIncluded": false, "secretsIncluded": false },
            })
        );
    } else {
        eprintln!("{message}");
    }
    ExitCode::from(exit)
}
