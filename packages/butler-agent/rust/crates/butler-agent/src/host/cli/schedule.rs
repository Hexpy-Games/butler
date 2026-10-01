//! `butler schedule` uses the App's canonical schedule service.

mod render;

use std::{ffi::OsString, path::PathBuf, process::ExitCode};

use reqwest::Method;
use serde_json::{Value, json};

use crate::host::{
    ResolvedInstallation,
    automation::client::ScheduleClient,
    cli::{error::CliError, settings as settings_cli},
};
use render::{report_error, report_success, safe_preview};

#[derive(Default)]
struct OutputOptions {
    json: bool,
    quiet: bool,
}

#[derive(Default)]
struct Options {
    data: Option<PathBuf>,
    output: OutputOptions,
    confirmed: bool,
    include_deleted: bool,
    status: Option<String>,
    title: Option<String>,
    prompt: Option<String>,
    session: Option<String>,
    interval_seconds: Option<i64>,
    schedule_type: Option<String>,
    run_at: Option<String>,
    start_at: Option<String>,
    state: Option<String>,
    access_mode: Option<String>,
    positionals: Vec<String>,
}

pub(crate) fn recognizes(args: &[OsString]) -> bool {
    let mut index = 0;
    while let Some(arg) = args.get(index) {
        match arg.to_string_lossy().as_ref() {
            "--data" | "--title" | "--prompt" | "--session" | "--interval-seconds" | "--run-at"
            | "--start-at" | "--state" | "--access-mode" | "--status" | "--schedule-type" => {
                index += 2;
            }
            value if value.starts_with('-') => index += 1,
            "schedule" | "automation" => return true,
            _ => return false,
        }
    }
    false
}

pub(crate) async fn run(installation: &ResolvedInstallation, args: &[OsString]) -> ExitCode {
    let json_requested = args.iter().any(|arg| arg == "--json");
    let options = match parse(args) {
        Ok(options) => options,
        Err(error) => return report_error("butler schedule", json_requested, &error),
    };
    let action = options.positionals.get(1).map(String::as_str).unwrap_or("");
    let command = match action {
        "list" => "butler schedule list",
        "show" => "butler schedule show",
        "create" => "butler schedule create",
        "update" => "butler schedule update",
        "run" => "butler schedule run",
        "delete" => "butler schedule delete",
        _ => "butler schedule",
    };
    let Ok(data_root) =
        settings_cli::resolve_data_root_override(options.data.clone(), installation)
    else {
        return report_error(
            command,
            options.output.json,
            &CliError::failed("butler_data_unavailable", "Butler DATA is unavailable."),
        );
    };
    let client = match ScheduleClient::local(&data_root) {
        Ok(client) => client,
        Err(error) => return report_error(command, options.output.json, &cli_error(&error)),
    };
    let result = execute(&client, &options).await;
    match result {
        Ok((data, human)) => report_success(&options, command, &data, &human),
        Err(error) => report_error(command, options.output.json, &error),
    }
}

async fn execute(client: &ScheduleClient, options: &Options) -> Result<(Value, String), CliError> {
    let action = options.positionals.get(1).map(String::as_str).unwrap_or("");
    let id = options.positionals.get(2).map(String::as_str).unwrap_or("");
    if matches!(action, "show" | "update" | "run" | "delete") && !safe_id(id) {
        return Err(CliError::invalid(
            "schedule id must contain 1-100 safe characters",
        ));
    }
    if action == "delete" && !options.confirmed {
        return Err(CliError::invalid(
            "schedule delete requires --yes or --non-interactive",
        ));
    }
    let data = match action {
        "list" if options.positionals.len() == 2 => {
            let suffix = if options.include_deleted { "?include_deleted=true" } else { "" };
            client.request(Method::GET, &format!("/automations{suffix}"), None).await.map_err(|error| cli_error(&error))?
        }
        "show" if options.positionals.len() == 3 => client.request(Method::GET, &format!("/automations/{id}"), None).await.map_err(|error| cli_error(&error))?,
        "create" if options.positionals.len() == 2 => {
            let prompt = options.prompt.as_deref().ok_or_else(|| CliError::invalid("--prompt is required"))?;
            let session = options.session.as_deref().ok_or_else(|| CliError::invalid("--session is required"))?;
            let kind = options.schedule_type.as_deref().unwrap_or(if options.run_at.is_some() { "once" } else { "interval" });
            client.request(Method::POST, "/automations", Some(json!({
                "title": options.title.as_deref().unwrap_or(prompt), "prompt_body": prompt,
                "target_session_id": session, "schedule_type": kind,
                "interval_seconds": options.interval_seconds.unwrap_or(0),
                "run_at": options.run_at, "start_at": options.start_at,
                "access_mode": options.access_mode,
            }))).await.map_err(|error| cli_error(&error))?
        }
        "update" if options.positionals.len() == 3 => client.request(Method::PATCH, &format!("/automations/{id}"), Some(json!({
            "title": options.title, "prompt_body": options.prompt,
            "target_session_id": options.session, "interval_seconds": options.interval_seconds,
            "run_at": options.run_at, "start_at": options.start_at, "schedule_type": options.schedule_type,
            "state": options.state, "access_mode": options.access_mode,
        }))).await.map_err(|error| cli_error(&error))?,
        "run" if options.positionals.len() == 3 => client.request(Method::POST, &format!("/automations/{id}/run"), Some(json!({}))).await.map_err(|error| cli_error(&error))?,
        "delete" if options.positionals.len() == 3 => client.request(Method::DELETE, &format!("/automations/{id}"), None).await.map_err(|error| cli_error(&error))?,
        _ => return Err(CliError::invalid("schedule requires list, show ID, create, update ID, run ID, or delete ID")),
    };
    let data = public_data(&data, action, options.status.as_deref());
    let human = if action == "list" {
        let count = data["automations"].as_array().map_or(0, Vec::len);
        format!("{count} schedules")
    } else {
        format!(
            "Schedule {action}: {}",
            data["automation"]["id"].as_str().unwrap_or(id)
        )
    };
    Ok((data, human))
}

fn public_data(data: &Value, action: &str, status: Option<&str>) -> Value {
    if action == "list" {
        let items = data["automations"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|value| status.is_none_or(|wanted| value["state"] == wanted))
            .map(safe_preview)
            .collect::<Vec<_>>();
        json!({"automations":items})
    } else if action == "run" {
        json!({"automation":safe_preview(data["automation"].clone()),"run":data["run"]})
    } else {
        json!({"automation":safe_preview(data["automation"].clone())})
    }
}

fn parse(args: &[OsString]) -> Result<Options, CliError> {
    let mut options = Options::default();
    let mut index = 0;
    while index < args.len() {
        let item = args[index].to_string_lossy();
        match item.as_ref() {
            "--data" | "--title" | "--prompt" | "--session" | "--interval-seconds" | "--run-at"
            | "--start-at" | "--state" | "--access-mode" | "--status" | "--schedule-type" => {
                let value = args
                    .get(index + 1)
                    .and_then(|v| v.to_str())
                    .filter(|v| !v.is_empty())
                    .ok_or_else(|| CliError::invalid(format!("{item} requires a value")))?;
                set_option(&mut options, &item, value)?;
                index += 2;
            }
            "--json" => {
                options.output.json = true;
                index += 1;
            }
            "--quiet" | "--silent" => {
                options.output.quiet = true;
                index += 1;
            }
            "--yes" | "--non-interactive" => {
                options.confirmed = true;
                index += 1;
            }
            "--include-deleted" => {
                options.include_deleted = true;
                index += 1;
            }
            "--verbose" => index += 1,
            value if value.starts_with('-') => {
                return Err(CliError::invalid(format!("unsupported option: {value}")));
            }
            _ => {
                options.positionals.push(item.into_owned());
                index += 1;
            }
        }
    }
    if options.positionals.first().map(String::as_str) == Some("automation") {
        eprintln!("butler automation is deprecated; use butler schedule.");
    }
    if !options
        .positionals
        .first()
        .is_some_and(|v| v == "schedule" || v == "automation")
    {
        return Err(CliError::invalid("schedule command is required"));
    }
    Ok(options)
}

fn set_option(options: &mut Options, name: &str, value: &str) -> Result<(), CliError> {
    match name {
        "--data" => options.data = Some(value.into()),
        "--title" => options.title = Some(value.into()),
        "--prompt" => options.prompt = Some(value.into()),
        "--session" => options.session = Some(value.into()),
        "--interval-seconds" => {
            options.interval_seconds = Some(
                value
                    .parse()
                    .map_err(|_| CliError::invalid("invalid interval"))?,
            );
        }
        "--run-at" => options.run_at = Some(value.into()),
        "--start-at" => options.start_at = Some(value.into()),
        "--schedule-type" => options.schedule_type = Some(value.into()),
        "--state" => options.state = Some(value.into()),
        "--access-mode" => options.access_mode = Some(value.into()),
        "--status" => options.status = Some(value.into()),
        _ => return Err(CliError::invalid("unknown schedule option")),
    }
    Ok(())
}

fn safe_id(id: &str) -> bool {
    (1..=100).contains(&id.len())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
}

fn cli_error(error: &crate::host::automation::client::ScheduleError) -> CliError {
    CliError::failed(error.code().to_owned(), error.message())
}
