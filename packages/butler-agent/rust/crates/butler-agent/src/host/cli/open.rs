//! `butler open`: opens the running Butler in the local browser without a
//! login prompt. The CLI reads the data folder's gateway token, asks the
//! gateway for a one-time connection code (`POST /connection-codes`) and
//! opens its `/connect?code=..` link, which sets an HttpOnly session cookie.

use std::ffi::OsString;
use std::process::{Command as Process, ExitCode, Stdio};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};

use crate::host::ResolvedInstallation;
use crate::host::cli::error::CliError;
use crate::host::service::configuration::AppServiceConfiguration;

const COMMAND: &str = "butler open";
const USAGE: &str = "open [--no-browser] [--json] [--quiet] [--data PATH]";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
/// How long `butler open` waits for a service that is still starting.
const STARTUP_PATIENCE: Duration = Duration::from_secs(30);

#[expect(
    clippy::struct_excessive_bools,
    reason = "independent command-line flags"
)]
#[derive(Default)]
struct Options {
    data: Option<String>,
    json: bool,
    quiet: bool,
    help: bool,
    no_browser: bool,
}

/// `POST /connection-codes` response data.
#[derive(Deserialize)]
struct ConnectionLink {
    url: String,
    code: String,
    expires_at: String,
}

#[derive(Deserialize)]
struct Envelope {
    data: ConnectionLink,
}

/// `open [options]`; unknown options are reported by [`run`].
pub(crate) fn recognizes(args: &[OsString]) -> bool {
    args.first().is_some_and(|arg| arg == "open")
}

pub(crate) async fn run(installation: &ResolvedInstallation, args: &[OsString]) -> ExitCode {
    let json_requested = args.iter().any(|arg| arg == "--json");
    let options = match parse(args.get(1..).unwrap_or_default()) {
        Ok(options) => options,
        Err(error) => return report_error(json_requested, &error),
    };
    if options.help {
        return report_success(&options, &json!({ "usage": USAGE }), USAGE);
    }
    match open(installation, &options).await {
        Ok((data, human)) => report_success(&options, &data, &human),
        Err(error) => report_error(options.json, &error),
    }
}

async fn open(
    installation: &ResolvedInstallation,
    options: &Options,
) -> Result<(Value, String), CliError> {
    let data_root = super::gateway::resolve_data(options.data.as_deref(), installation)
        .map_err(|error| CliError::failed("butler_data_unavailable", error.message()))?;
    let endpoint = super::gateway::running_app_endpoint(&data_root, installation, STARTUP_PATIENCE)
        .await
        .map_err(|error| CliError::failed("butler_status_unavailable", error.message()))?
        .ok_or_else(|| {
            CliError::failed(
                "butler_not_running",
                "Butler is not running. Start it with `butler start`, then run `butler open` again.",
            )
        })?;
    let link = request_link(&endpoint, &data_root).await?;
    let opened = !options.no_browser && open_in_browser(&link.url);
    let data = json!({
        "url": link.url,
        "code": link.code,
        "expiresAt": link.expires_at,
        "browserOpened": opened,
    });
    let lead = if opened {
        "Opened Butler in your browser. If it did not open, visit:"
    } else {
        "Open this link in your browser:"
    };
    let human = format!(
        "{lead}\n  {}\nConnection code (one use, 5 minutes): {}",
        link.url, link.code
    );
    Ok((data, human))
}

/// Mints a connection code with the data folder's gateway token.
async fn request_link(
    endpoint: &str,
    data_root: &std::path::Path,
) -> Result<ConnectionLink, CliError> {
    let auth = AppServiceConfiguration::capture(data_root)
        .gateway_config()
        .local_auth;
    let token = auth.token().ok_or_else(|| {
        CliError::failed(
            "local_auth_unavailable",
            "The gateway token in this data folder cannot be read.",
        )
    })?;
    let unavailable = |source: reqwest::Error| {
        CliError::failed(
            "connection_code_unavailable",
            "Butler did not issue a connection code.",
        )
        .with_source(source)
    };
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(unavailable)?;
    let response = client
        .post(format!("{endpoint}/connection-codes"))
        .bearer_auth(token)
        .send()
        .await
        .map_err(unavailable)?
        .error_for_status()
        .map_err(unavailable)?;
    Ok(response.json::<Envelope>().await.map_err(unavailable)?.data)
}

/// Hands the link to the desktop's default browser; false when that fails.
fn open_in_browser(url: &str) -> bool {
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    Process::new(opener)
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

fn parse(args: &[OsString]) -> Result<Options, CliError> {
    let mut options = Options::default();
    let mut args = args.iter().map(|arg| arg.to_string_lossy());
    while let Some(arg) = args.next() {
        match arg.as_ref() {
            "--json" => options.json = true,
            "--quiet" | "--silent" => options.quiet = true,
            "--help" | "-h" => options.help = true,
            "--no-browser" => options.no_browser = true,
            "--data" => {
                let value = args
                    .next()
                    .ok_or_else(|| CliError::invalid("--data needs a path"))?;
                options.data = Some(value.into_owned());
            }
            value => {
                if let Some(path) = value.strip_prefix("--data=") {
                    options.data = Some(path.to_owned());
                } else {
                    return Err(CliError::invalid(format!("unexpected argument: {value}")));
                }
            }
        }
    }
    Ok(options)
}

fn report_success(options: &Options, data: &Value, human: &str) -> ExitCode {
    if options.json {
        println!(
            "{}",
            json!({
                "ok": true,
                "command": COMMAND,
                "data": data,
                "error": null,
                "privacy": { "rawTextIncluded": false, "secretsIncluded": true }
            })
        );
    } else if !options.quiet {
        println!("{human}");
    }
    ExitCode::SUCCESS
}

fn report_error(json_output: bool, error: &CliError) -> ExitCode {
    if json_output {
        println!(
            "{}",
            json!({
                "ok": false,
                "command": COMMAND,
                "data": null,
                "error": { "code": error.code, "message": error.message },
                "privacy": { "rawTextIncluded": false, "secretsIncluded": false }
            })
        );
    } else {
        eprintln!("{}", error.message);
    }
    ExitCode::from(error.exit)
}
