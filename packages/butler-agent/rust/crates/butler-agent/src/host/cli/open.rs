//! `butler open`: opens the running Butler in the local browser without a
//! login prompt. The CLI reads the data folder's gateway token, asks the
//! gateway for a one-time connection code (`POST /connection-codes`) and
//! opens its `/connect?code=..` link, which sets an HttpOnly session cookie.

use std::ffi::OsString;
use std::process::{ExitCode, Stdio};
use std::time::Duration;

use serde::{Deserialize, Serialize};

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

/// `butler open --json` data: the link, its code and whether a browser
/// opened it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenResult {
    url: String,
    code: String,
    expires_at: String,
    browser_opened: bool,
}

/// `butler open --help --json` data.
#[derive(Serialize)]
struct Usage {
    usage: &'static str,
}

/// The CLI JSON envelope `butler open --json` prints.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Report<'a, T> {
    ok: bool,
    command: &'static str,
    data: Option<T>,
    error: Option<ReportedError<'a>>,
    privacy: Privacy,
}

#[derive(Serialize)]
struct ReportedError<'a> {
    code: &'a str,
    message: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Privacy {
    raw_text_included: bool,
    /// The connection code is a credential for one browser session.
    secrets_included: bool,
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
        return report_success(&options, Usage { usage: USAGE }, false, USAGE);
    }
    match open(installation, &options).await {
        Ok((data, human)) => report_success(&options, data, true, &human),
        Err(error) => report_error(options.json, &error),
    }
}

async fn open(
    installation: &ResolvedInstallation,
    options: &Options,
) -> Result<(OpenResult, String), CliError> {
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
    let lead = if opened {
        "Opened Butler in your browser. If it did not open, visit:"
    } else {
        "Open this link in your browser:"
    };
    let human = format!(
        "{lead}\n  {}\nConnection code (one use, 5 minutes): {}",
        link.url, link.code
    );
    let data = OpenResult {
        url: link.url,
        code: link.code,
        expires_at: link.expires_at,
        browser_opened: opened,
    };
    Ok((data, human))
}

/// Mints a connection code with the data folder's gateway token.
async fn request_link(
    endpoint: &str,
    data_root: &std::path::Path,
) -> Result<ConnectionLink, CliError> {
    let app = AppServiceConfiguration::capture(data_root);
    let auth = app.gateway_config().local_auth;
    let token = auth.token().ok_or_else(|| {
        let cause = app
            .credential_errors()
            .first()
            .map(|error| format!(" ({})", error.diagnostic()))
            .unwrap_or_default();
        CliError::failed(
            "local_auth_unavailable",
            format!("The gateway token in this data folder cannot be read{cause}."),
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
    let mut link = response.json::<Envelope>().await.map_err(unavailable)?.data;
    // Endpoint discovery is authoritative: the gateway may have built its URL
    // from a stale advertised port instead of the port this request reached.
    let mut url = reqwest::Url::parse(endpoint).map_err(|_| {
        CliError::failed(
            "connection_code_unavailable",
            "Invalid running agent endpoint.",
        )
    })?;
    url.set_path("/connect");
    url.set_query(None);
    url.query_pairs_mut().append_pair("code", &link.code);
    link.url = url.into();
    Ok(link)
}

/// Hands the link to the desktop's default browser; false when that fails.
fn open_in_browser(url: &str) -> bool {
    butler_platform::desktop::open_url(url).is_some_and(|mut command| {
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    })
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

fn report_success<T: Serialize>(
    options: &Options,
    data: T,
    secrets_included: bool,
    human: &str,
) -> ExitCode {
    if options.json {
        return print_report(&Report::<T> {
            ok: true,
            command: COMMAND,
            data: Some(data),
            error: None,
            privacy: Privacy {
                raw_text_included: false,
                secrets_included,
            },
        });
    }
    if !options.quiet {
        println!("{human}");
    }
    ExitCode::SUCCESS
}

fn report_error(json_output: bool, error: &CliError) -> ExitCode {
    if json_output {
        print_report(&Report::<Usage> {
            ok: false,
            command: COMMAND,
            data: None,
            error: Some(ReportedError {
                code: &error.code,
                message: &error.message,
            }),
            privacy: Privacy {
                raw_text_included: false,
                secrets_included: false,
            },
        });
    } else {
        eprintln!("{}", error.message);
    }
    ExitCode::from(error.exit)
}

/// Prints the JSON envelope; exit 1 when it cannot be encoded.
fn print_report<T: Serialize>(report: &Report<'_, T>) -> ExitCode {
    match serde_json::to_string(report) {
        Ok(text) => {
            println!("{text}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("{COMMAND}: cannot encode the JSON report: {error}");
            ExitCode::FAILURE
        }
    }
}
