//! User-facing remote access commands; all mutations go through the service.
mod client;
use crate::host::{
    ResolvedInstallation,
    cli::{error::CliError, settings},
};
use client::Client;
use reqwest::Method;
use serde_json::{Value, json};
use std::{
    ffi::OsString,
    io::{self, IsTerminal, Write},
    path::PathBuf,
    process::ExitCode,
};

#[derive(Default)]
struct Options {
    data: Option<PathBuf>,
    words: Vec<String>,
    json: bool,
    rotate: bool,
    yes: bool,
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
        let data = execute(&client, &options).await?;
        // Only stdout reaches the local caller; no tracing, service log or argv contains the code.
        if options.json {
            println!(
                "{}",
                json!({"ok":true,"command":"butler remote","data":data,"error":null,
                "privacy":{"rawTextIncluded":false,"secretsIncluded": options.words[1] == "code"}})
            );
        } else if options.words[1] == "code" {
            println!(
                "{}",
                data["code"].as_str().ok_or_else(|| CliError::failed(
                    "code_unavailable",
                    "Connection code unavailable."
                ))?
            );
        } else {
            render_status(&data);
            if options.words[1] == "enable" {
                println!("연결 코드: butler remote code / Connection code: butler remote code");
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
            "--rotate" => options.rotate = true,
            "--yes" => options.yes = true,
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
        ["remote", "status" | "enable" | "disable" | "code"]
            | ["remote", "hosts", "add" | "remove", _]
    );
    let code = words.get(1) == Some(&"code");
    if !valid
        || (options.rotate && !code)
        || (options.yes && !options.rotate)
        || (options.json && !matches!(words.get(1), Some(&"status" | &"code")))
    {
        return Err(CliError::invalid("Use butler help remote."));
    }
    Ok(options)
}

async fn execute(client: &Client, options: &Options) -> Result<Value, CliError> {
    match options.words[1].as_str() {
        "code" => {
            if options.rotate && !options.yes {
                confirm_rotation()?;
            }
            let path = if options.rotate {
                "/security/connection-code/rotate"
            } else {
                "/security/connection-code/reveal"
            };
            client.request(Method::POST, path, None).await
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

fn confirm_rotation() -> Result<(), CliError> {
    if !io::stdin().is_terminal() {
        return Err(CliError::invalid(
            "Rotation invalidates the old code. Run with --yes to confirm.",
        ));
    }
    eprint!("새 코드 발급 (기존 코드 무효화)? / Rotate code (invalidate old code)? [y/N] ");
    io::stderr()
        .flush()
        .map_err(|_| CliError::failed("confirmation_failed", "Cannot confirm rotation."))?;
    let mut answer = String::new();
    io::stdin()
        .read_line(&mut answer)
        .map_err(|_| CliError::failed("confirmation_failed", "Cannot confirm rotation."))?;
    if !answer.trim().eq_ignore_ascii_case("y") && !answer.trim().eq_ignore_ascii_case("yes") {
        return Err(CliError::invalid("Rotation cancelled."));
    }
    Ok(())
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
    println!(
        "연결 코드 / Connection code: {} (created: {})",
        data["connection_code"]["masked"], data["connection_code"]["created_at"]
    );
}
