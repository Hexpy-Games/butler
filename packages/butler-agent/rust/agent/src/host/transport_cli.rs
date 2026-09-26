//! Native one-shot transport status and mock-send smoke commands.

use std::{ffi::OsString, path::PathBuf, process::ExitCode};

use serde_json::{Value, json};

use super::{ResolvedInstallation, settings_cli};

const MOCK_CAPABILITIES: &[(&str, bool)] = &[
    ("supportsThreads", true),
    ("supportsMessageEdit", true),
    ("supportsReactions", false),
    ("supportsAttachments", true),
    ("supportsStreamingEdits", false),
    ("supportsPresence", true),
    ("supportsActivityEvents", true),
    ("supportsProgressDrafts", true),
    ("supportsFinalAggregateOnly", false),
];

#[derive(Default)]
struct Options {
    data: Option<PathBuf>,
    json: bool,
    quiet: bool,
    transport: Option<String>,
    positionals: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Command {
    Status,
    Test,
}

impl Command {
    fn name(self) -> &'static str {
        match self {
            Self::Status => "butler transport status",
            Self::Test => "butler transport test",
        }
    }
}

struct CliError {
    code: &'static str,
    message: String,
    exit: u8,
}

impl CliError {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: "invalid_arguments",
            message: message.into(),
            exit: 2,
        }
    }

    fn failed(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            exit: 1,
        }
    }
}

pub fn recognizes(args: &[OsString]) -> bool {
    let values = positionals_without_options(args);
    matches!(values.first().map(String::as_str), Some("transport"))
        && matches!(values.get(1).map(String::as_str), Some("status" | "test"))
}

pub async fn run(installation: ResolvedInstallation, args: Vec<OsString>) -> ExitCode {
    let json_requested = args.iter().any(|arg| arg == "--json");
    let (options, command) = match parse(&args) {
        Ok(parsed) => parsed,
        Err(error) => return report_error(error_command(&args), json_requested, error),
    };
    if let Err(message) =
        settings_cli::resolve_data_root_override(options.data.clone(), &installation)
    {
        return report_error(
            command.name(),
            options.json,
            CliError::failed("butler_data_unavailable", message),
        );
    }

    let (data, human) = match command {
        Command::Status => {
            let capabilities = MOCK_CAPABILITIES
                .iter()
                .filter(|(_, enabled)| *enabled)
                .map(|(name, _)| Value::String((*name).to_owned()))
                .collect::<Vec<_>>();
            let data = json!({
                "transports": [{
                    "id": "mock",
                    "configured": true,
                    "paired": true,
                    "capabilities": capabilities,
                }],
            });
            (data, "mock: configured=true paired=true".to_owned())
        }
        Command::Test => {
            let transport = options.transport.as_deref().unwrap_or("mock");
            if transport != "mock" {
                return report_error(
                    command.name(),
                    options.json,
                    CliError::invalid(format!("unsupported transport: {transport}")),
                );
            }
            let mut mock = MockTransportAdapter::new("mock");
            let result = mock.send("mock");
            let data = json!({
                "transport": transport,
                "ok": result.is_ok(),
                "sentActions": mock.sent_actions,
                "transportMessageId": result.ok(),
            });
            let passed = data["ok"].as_bool().unwrap_or(false);
            (
                data,
                format!(
                    "Mock transport test: {}.",
                    if passed { "passed" } else { "failed" }
                ),
            )
        }
    };
    report_success(&options, command.name(), data, &human)
}

struct MockTransportAdapter {
    id: String,
    sent_actions: usize,
}

impl MockTransportAdapter {
    fn new(id: &str) -> Self {
        Self {
            id: id.to_owned(),
            sent_actions: 0,
        }
    }

    fn send(&mut self, action_transport: &str) -> Result<String, String> {
        if action_transport != self.id {
            return Err(format!("transport_mismatch:{action_transport}"));
        }
        self.sent_actions += 1;
        Ok(format!("{}:{}", self.id, self.sent_actions))
    }
}

fn parse(args: &[OsString]) -> Result<(Options, Command), CliError> {
    let mut options = Options::default();
    let mut index = 0;
    while index < args.len() {
        let value = args[index].to_string_lossy();
        match value.as_ref() {
            "--data" => {
                let Some(raw) = args
                    .get(index + 1)
                    .filter(|raw| !raw.to_string_lossy().starts_with("--"))
                else {
                    return Err(CliError::invalid("--data requires a path"));
                };
                options.data = Some(PathBuf::from(raw.as_os_str()));
                index += 2;
                continue;
            }
            value if value.starts_with("--data=") => {
                let path = &value[7..];
                if path.is_empty() {
                    return Err(CliError::invalid("--data requires a path"));
                }
                options.data = Some(PathBuf::from(path));
            }
            "--transport" => {
                if let Some(raw) = args
                    .get(index + 1)
                    .filter(|raw| !raw.to_string_lossy().starts_with("--"))
                {
                    options.transport = Some(raw.to_string_lossy().into_owned());
                    index += 2;
                    continue;
                }
            }
            "--home" => {
                return Err(CliError::invalid(
                    "--home is unsupported; native commands use --data",
                ));
            }
            "--json" => options.json = true,
            "--quiet" | "--silent" => options.quiet = true,
            "--verbose" | "--yes" | "--non-interactive" => {}
            _ => options.positionals.push(value.into_owned()),
        }
        index += 1;
    }
    let command = match options.positionals.as_slice() {
        [transport, status, ..] if transport == "transport" && status == "status" => {
            Command::Status
        }
        [transport, test, ..] if transport == "transport" && test == "test" => Command::Test,
        _ => {
            return Err(CliError::invalid(
                "supported commands: transport status|test",
            ));
        }
    };
    Ok((options, command))
}

fn positionals_without_options(args: &[OsString]) -> Vec<String> {
    let mut values = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let value = args[index].to_string_lossy();
        match value.as_ref() {
            "--data" | "--home" | "--transport" => {
                index += if args
                    .get(index + 1)
                    .is_some_and(|next| !next.to_string_lossy().starts_with("--"))
                {
                    2
                } else {
                    1
                };
            }
            value if value.starts_with("--data=") => index += 1,
            "--json" | "--quiet" | "--silent" | "--verbose" | "--yes" | "--non-interactive" => {
                index += 1;
            }
            _ => {
                values.push(value.into_owned());
                index += 1;
            }
        }
    }
    values
}

fn error_command(args: &[OsString]) -> &'static str {
    let values = positionals_without_options(args);
    if values.first().is_some_and(|value| value == "transport")
        && values.get(1).is_some_and(|value| value == "test")
    {
        Command::Test.name()
    } else {
        "butler transport"
    }
}

fn report_success(options: &Options, command: &str, data: Value, human: &str) -> ExitCode {
    if options.json {
        println!(
            "{}",
            json!({
                "ok": true,
                "command": command,
                "data": data,
                "error": null,
                "privacy": { "rawTextIncluded": false, "secretsIncluded": false }
            })
        );
    } else if !options.quiet {
        println!("{human}");
    }
    ExitCode::SUCCESS
}

fn report_error(command: &str, json_output: bool, error: CliError) -> ExitCode {
    if json_output {
        println!(
            "{}",
            json!({
                "ok": false,
                "command": command,
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
