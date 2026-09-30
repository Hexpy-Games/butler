//! Command-line entry: classify argv into one [`Command`] and run it.
//!
//! Classification order is significant: the first family that claims the
//! arguments runs, exactly as the executable has always dispatched them.

use std::ffi::OsString;
use std::path::PathBuf;
use std::process::ExitCode;

use crate::host::ResolvedInstallation;

/// Returns true when a command family claims the arguments.
type Recognizer = fn(&[OsString]) -> bool;

/// Every command family the `butler-agent` executable accepts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Command {
    Public,
    ServiceControl,
    Doctor,
    Mcp,
    Settings,
    Observability,
    Schedule,
    Update,
    Status,
    Open,
    Skills,
    OauthLogin,
    RunService,
    Unexpected,
}

impl Command {
    /// Classifies command arguments (installation options already removed).
    pub fn classify(args: &[OsString]) -> Self {
        use crate::host::cli;
        let families: [(Recognizer, Self); 10] = [
            (cli::public::recognizes, Self::Public),
            (cli::service::recognizes, Self::ServiceControl),
            (cli::doctor::recognizes, Self::Doctor),
            (cli::settings::recognizes, Self::Settings),
            (cli::observability::recognizes, Self::Observability),
            (cli::schedule::recognizes, Self::Schedule),
            (cli::update::recognizes, Self::Update),
            (cli::status::recognizes, Self::Status),
            (cli::open::recognizes, Self::Open),
            (crate::host::mcp::recognizes, Self::Mcp),
        ];
        if let Some((_, command)) = families.iter().find(|(recognizes, _)| recognizes(args)) {
            return *command;
        }
        if is_skills_command(args) {
            return Self::Skills;
        }
        if args.len() == 1 && args[0] == "oauth-login" {
            return Self::OauthLogin;
        }
        if args.is_empty() {
            Self::RunService
        } else {
            Self::Unexpected
        }
    }

    /// Runs the command and returns the process exit code.
    pub(crate) async fn run(
        self,
        installation: ResolvedInstallation,
        args: Vec<OsString>,
    ) -> ExitCode {
        use crate::host::cli;
        match self {
            Self::Public => cli::public::run(&installation, &args),
            Self::ServiceControl => cli::service::run_native_service_cli(installation, args).await,
            Self::Doctor => cli::doctor::run(&installation, &args),
            Self::Mcp => Box::pin(crate::host::mcp::run(installation, args)).await,
            Self::Settings => cli::settings::run(installation, args).await,
            Self::Observability => cli::observability::run(installation, args).await,
            Self::Schedule => cli::schedule::run(&installation, &args).await,
            Self::Update => Box::pin(cli::update::run(installation, args)).await,
            Self::Status => cli::status::run_native_status_cli(installation, args).await,
            Self::Open => cli::open::run(&installation, &args).await,

            Self::Skills => {
                let result = cli::skills::run_native_skills_cli(installation, args).await;
                printed(&result.stdout, &result.stderr, result.exit_code)
            }

            Self::OauthLogin => {
                match cli::oauth_login::run_native_oauth_login(installation).await {
                    Ok(()) => ExitCode::SUCCESS,
                    Err(error) => {
                        eprintln!("{error}");
                        ExitCode::FAILURE
                    }
                }
            }
            Self::RunService => {
                match crate::host::service::entrypoint::run_native_service(installation).await {
                    Ok(session) => {
                        if let Some(session) = session {
                            println!("{session}");
                        }
                        ExitCode::SUCCESS
                    }
                    Err(error) => {
                        eprintln!("{error}");
                        ExitCode::FAILURE
                    }
                }
            }
            Self::Unexpected => {
                eprintln!("Unknown command. Use butler --help.");
                ExitCode::from(2)
            }
        }
    }
}

/// The executable entry: the private embedding worker, or installation
/// resolution followed by one classified command.
pub async fn main(args: Vec<OsString>) -> ExitCode {
    // Internal child mode. It must not resolve installation resources or start
    // the service before the first private embedding request.
    if args.len() == 1 && args[0] == "--private-embedding-worker" {
        return crate::host::embedding::worker::run().await;
    }
    let (installation, command_args) = match installation(&args) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::from(2);
        }
    };
    Command::classify(&command_args)
        .run(installation, command_args)
        .await
}

fn printed(stdout: &str, stderr: &str, exit_code: u8) -> ExitCode {
    print!("{stdout}");
    eprint!("{stderr}");
    ExitCode::from(exit_code)
}

fn installation(
    args: &[OsString],
) -> Result<(ResolvedInstallation, Vec<OsString>), crate::host::HostError> {
    let mut root = None;
    let mut resources = None;
    let mut command = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let name = args[index].to_string_lossy();
        match name.as_ref() {
            "--installation-root" | "--resource-root" => {
                let value = args
                    .get(index + 1)
                    .ok_or_else(|| format!("{name} requires a path"))?;
                if name == "--installation-root" {
                    root = Some(PathBuf::from(value));
                } else {
                    resources = Some(PathBuf::from(value));
                }
                index += 2;
            }
            _ => {
                command.push(args[index].clone());
                index += 1;
            }
        }
    }
    let installation = match (root, resources) {
        (None, None) => ResolvedInstallation::standalone()?,
        (Some(root), Some(resources)) => ResolvedInstallation::desktop(
            std::env::current_exe().map_err(crate::host::HostError::from_error)?,
            root,
            resources,
        )?,
        (None, Some(_)) => return Err("--installation-root is required".to_owned().into()),
        (Some(_), None) => return Err("--resource-root is required".to_owned().into()),
    };
    Ok((installation, command))
}

fn is_skills_command(args: &[OsString]) -> bool {
    let mut index = 0;
    while index < args.len() {
        match args[index].to_string_lossy().as_ref() {
            "--data" | "--home" => index += 2,
            "--json" | "--quiet" | "--silent" | "--verbose" | "--yes" | "--non-interactive" => {
                index += 1;
            }
            command => return command == "skills",
        }
    }
    false
}
