//! User-facing remote access commands; all mutations go through the service.
mod client;
mod pair;
use crate::host::{
    ResolvedInstallation,
    cli::{error::CliError, settings},
};
use client::Client;
use reqwest::Method;
use serde_json::{Value, json};
use std::{ffi::OsString, path::PathBuf, process::ExitCode};

#[derive(Default)]
struct Options {
    data: Option<PathBuf>,
    words: Vec<String>,
    json: bool,
    revoke: Option<String>,
    revoke_all: bool,
}

pub(crate) fn recognizes(args: &[OsString]) -> bool {
    let mut index = 0;
    while let Some(arg) = args.get(index) {
        match arg.to_string_lossy().as_ref() {
            "--data" => index += 2,
            value if value.starts_with('-') => index += 1,
            value => return value == "remote",
        }
    }
    false
}

pub(crate) async fn run(installation: &ResolvedInstallation, args: &[OsString]) -> ExitCode {
    let json_output = args.iter().any(|arg| arg == "--json");
    let result = async {
        let options = parse(args)?;
        let root = settings::resolve_data_root_override(options.data.clone(), installation)
            .map_err(|_| CliError::failed("data_unavailable", "Butler DATA is unavailable."))?;
        let client = Client::local(&root)?;
        if matches!(options.words[1].as_str(), "pair" | "code") {
            return pair::run(&client).await;
        }
        let data = execute(&client, &options).await?;
        if options.json {
            println!(
                "{}",
                json!({"ok":true,"command":"butler remote","data":data,"error":null,
                "privacy":{"rawTextIncluded":false,"secretsIncluded":false}})
            );
        } else if options.words[1] == "devices" {
            println!(
                "{}",
                serde_json::to_string_pretty(&data).map_err(|_| CliError::failed(
                    "remote_response_invalid",
                    "Invalid device response."
                ))?
            );
        } else {
            render_status(&data);
            if options.words[1] == "enable" {
                println!("기기 연결: butler remote pair / Pair a device: butler remote pair");
            }
        }
        Ok::<(), CliError>(())
    }
    .await;
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            if json_output {
                println!(
                    "{}",
                    json!({"ok":false,"command":"butler remote","data":null,
                    "error":{"code":error.code,"message":error.message},
                    "privacy":{"rawTextIncluded":false,"secretsIncluded":false}})
                );
            } else {
                eprintln!("{error}");
            }
            ExitCode::from(error.exit)
        }
    }
}

fn parse(args: &[OsString]) -> Result<Options, CliError> {
    let mut options = Options::default();
    let mut index = 0;
    while let Some(arg) = args.get(index) {
        match arg.to_string_lossy().as_ref() {
            "--data" => {
                index += 1;
                options.data = Some(
                    args.get(index)
                        .filter(|arg| !arg.to_string_lossy().starts_with('-'))
                        .ok_or_else(|| CliError::invalid("--data requires a path"))?
                        .into(),
                );
            }
            "--json" => options.json = true,
            "--revoke-all" => options.revoke_all = true,
            "--revoke" => {
                index += 1;
                let id = args
                    .get(index)
                    .ok_or_else(|| CliError::invalid("--revoke requires a device ID"))?
                    .to_string_lossy();
                if uuid::Uuid::parse_str(&id).is_err() {
                    return Err(CliError::invalid("Invalid device ID."));
                }
                options.revoke = Some(id.into_owned());
            }
            value if value.starts_with("--data=") => options.data = Some(value[7..].into()),
            value if value.starts_with('-') => {
                return Err(CliError::invalid(format!("Unsupported option: {value}")));
            }
            value => options.words.push(value.into()),
        }
        index += 1;
    }
    let words = options.words.iter().map(String::as_str).collect::<Vec<_>>();
    let valid = matches!(
        words.as_slice(),
        [
            "remote",
            "status" | "enable" | "disable" | "pair" | "code" | "devices"
        ] | ["remote", "hosts", "add" | "remove", _]
    );
    let devices = words.get(1) == Some(&"devices");
    if !valid
        || ((options.revoke.is_some() || options.revoke_all) && !devices)
        || (options.revoke.is_some() && options.revoke_all)
        || (options.json && !matches!(words.get(1), Some(&"status" | &"devices")))
    {
        return Err(CliError::invalid("Use butler help remote."));
    }
    Ok(options)
}

async fn execute(client: &Client, options: &Options) -> Result<Value, CliError> {
    match options.words[1].as_str() {
        "devices" => {
            if options.revoke_all || options.revoke.is_some() {
                let path = options.revoke.as_ref().map_or_else(
                    || "/security/devices".into(),
                    |id| format!("/security/devices/{id}"),
                );
                client.request(Method::DELETE, &path, None).await?;
            }
            client.request(Method::GET, "/security/devices", None).await
        }
        "status" => client.request(Method::GET, "/security", None).await,
        action => {
            let security = if action == "hosts" {
                let view = client.request(Method::GET, "/security", None).await?;
                let mut hosts: Vec<String> = serde_json::from_value(view["allowed_hosts"].clone())
                    .map_err(|_| {
                        CliError::failed("remote_response_invalid", "Invalid allowed hosts.")
                    })?;
                let host = butler_gateway::gateway::normalize_allowed_host(&options.words[3])
                    .map_err(|_| {
                        CliError::invalid(
                            "호스트 이름이나 IP를 입력하세요. / Enter a host name or IP.",
                        )
                    })?;
                if options.words[2] == "add" {
                    if !hosts.contains(&host) {
                        hosts.push(host);
                    }
                } else {
                    hosts.retain(|value| value != &host);
                }
                json!({"allowed_hosts":hosts})
            } else {
                json!({"remote_access_enabled": action == "enable"})
            };
            client
                .request(
                    Method::PATCH,
                    "/settings",
                    Some(json!({"security":security})),
                )
                .await?;
            client.request(Method::GET, "/security", None).await
        }
    }
}

fn render_status(data: &Value) {
    println!(
        "원격 접근 / Remote access: {}",
        if data["remote_access_enabled"] == true {
            "enabled"
        } else {
            "disabled"
        }
    );
    for (key, label) in [
        ("bind_addresses", "바인드 / Bind"),
        ("lan_urls", "LAN URL"),
        ("bind_errors", "바인드 오류 / Bind errors"),
        ("allowed_hosts", "허용 호스트 / Allowed hosts"),
    ] {
        println!("{label}: {}", data[key]);
    }
}
