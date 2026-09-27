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
    /// `conversation recover ...`
    ConversationRecovery,
    /// Public status commands (`health`, `version`, ...).
    Public,
    /// `start`, `service ...` and bare service options.
    ServiceControl,
    /// `doctor`
    Doctor,
    /// `mcp ...` (registry commands and the stdio MCP server).
    Mcp,
    /// `personalization ...`
    Personalization,
    /// `model ...`, `auth ...`, `config ...`
    Settings,
    /// `metrics ...`, `logs`, `ps`
    Observability,
    /// `search ...`, `web ...`
    WebAccess,
    /// `schedule ...` (and its deprecated spelling `automation ...`)
    Schedule,
    /// `update ...`
    Update,
    /// `status`, `model status`, `metrics status`, ...
    Status,
    /// `context ...`
    Context,
    /// `transport ...`
    Transport,
    /// `gateway ...`
    Gateway,
    /// `work ...`
    Work,
    /// `skills ...`
    Skills,
    /// `cognition`/`cog` operator commands.
    CognitionOperator,
    /// `cognition memory rebuild initialize-empty`
    MemoryInitialize,
    /// `cognition memory rebuild <stage>`
    MemoryRebuild,
    /// `cognition memory maintain`
    MemoryMaintain,
    /// Any other `cognition` command: a consolidation run.
    Consolidation,
    /// `oauth-login`
    OauthLogin,
    /// No arguments: run the service.
    RunService,
    /// Arguments no family claims.
    Unexpected,
}

impl Command {
    /// Classifies command arguments (installation options already removed).
    pub fn classify(args: &[OsString]) -> Self {
        use crate::host::cli;
        let families: [(Recognizer, Self); 16] = [
            (
                cli::conversation_recovery::recognizes,
                Self::ConversationRecovery,
            ),
            (cli::public::recognizes, Self::Public),
            (cli::service::recognizes, Self::ServiceControl),
            (cli::doctor::recognizes, Self::Doctor),
            (crate::host::mcp::recognizes, Self::Mcp),
            (cli::personalization::recognizes, Self::Personalization),
            (cli::settings::recognizes, Self::Settings),
            (cli::observability::recognizes, Self::Observability),
            (cli::web_access::recognizes, Self::WebAccess),
            (cli::schedule::recognizes, Self::Schedule),
            (cli::update::recognizes, Self::Update),
            (cli::status::recognizes, Self::Status),
            (cli::context::recognizes, Self::Context),
            (cli::transport::recognizes, Self::Transport),
            (cli::gateway::recognizes, Self::Gateway),
            (cli::work::recognizes, Self::Work),
        ];
        if let Some((_, command)) = families.iter().find(|(recognizes, _)| recognizes(args)) {
            return *command;
        }
        if is_skills_command(args) {
            return Self::Skills;
        }
        if is_cognition_command(args) {
            return if cli::cognition::recognizes(args) {
                Self::CognitionOperator
            } else if is_memory_initialize_command(args) {
                Self::MemoryInitialize
            } else if is_memory_rebuild_command(args) {
                Self::MemoryRebuild
            } else if is_memory_maintain_command(args) {
                Self::MemoryMaintain
            } else {
                Self::Consolidation
            };
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
        use crate::host::{cli, memory_jobs};
        match self {
            Self::ConversationRecovery => cli::conversation_recovery::run(installation, args).await,
            Self::Public => cli::public::run(&installation, &args),
            Self::ServiceControl => cli::service::run_native_service_cli(installation, args).await,
            Self::Doctor => cli::doctor::run(&installation, &args),
            Self::Mcp => Box::pin(crate::host::mcp::run(installation, args)).await,
            Self::Personalization => cli::personalization::run(installation, args).await,
            Self::Settings => cli::settings::run(installation, args).await,
            Self::Observability => cli::observability::run(installation, args).await,
            Self::WebAccess => cli::web_access::run(installation, args).await,
            Self::Schedule => cli::schedule::run(&installation, &args),
            Self::Update => Box::pin(cli::update::run(installation, args)).await,
            Self::Status => cli::status::run_native_status_cli(installation, args).await,
            Self::Context => cli::context::run(installation, args).await,
            Self::Transport => cli::transport::run(&installation, &args),
            Self::Gateway => cli::gateway::run(installation, args).await,
            Self::Work => {
                let result = cli::work::run(installation, args).await;
                printed(&result.stdout, &result.stderr, result.exit_code)
            }
            Self::Skills => {
                let result = cli::skills::run_native_skills_cli(installation, args).await;
                printed(&result.stdout, &result.stderr, result.exit_code)
            }
            Self::CognitionOperator => cli::cognition::run(installation, args).await,
            Self::MemoryInitialize => {
                let result = memory_jobs::initialize::run(installation, args).await;
                printed(&result.stdout, &result.stderr, result.exit_code)
            }
            Self::MemoryRebuild => {
                let result = memory_jobs::rebuild::run(installation, args).await;
                printed(&result.stdout, &result.stderr, result.exit_code)
            }
            Self::MemoryMaintain => {
                let result = memory_jobs::maintain::run(installation, args).await;
                printed(&result.stdout, &result.stderr, result.exit_code)
            }
            Self::Consolidation => {
                let result =
                    cli::consolidation::run_native_consolidation_cli(installation, args).await;
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
                        println!("{session}");
                        ExitCode::SUCCESS
                    }
                    Err(error) => {
                        eprintln!("{error}");
                        ExitCode::FAILURE
                    }
                }
            }
            Self::Unexpected => {
                eprintln!("Unexpected argument. Use --help for service startup.");
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

fn is_cognition_command(args: &[OsString]) -> bool {
    let mut index = 0;
    while index < args.len() {
        match args[index].to_string_lossy().as_ref() {
            "--data" | "--home" | "--run-id" => index += 2,
            "--json"
            | "--quiet"
            | "--silent"
            | "--verbose"
            | "--yes"
            | "--non-interactive"
            | "--manual"
            | "--resume"
            | "--hot-cache-backfill-only" => index += 1,
            command => return command == "cognition" || command == "cog",
        }
    }
    false
}

/// Positional arguments after skipping `--flag value` pairs for `valued` flags
/// and bare `--flag`s.
fn positionals(args: &[OsString], valued: &[&str]) -> Vec<String> {
    let mut positional = Vec::new();
    let mut index = 0;
    while index < args.len() {
        match args[index].to_string_lossy().as_ref() {
            value if valued.contains(&value) => index += 2,
            value if value.starts_with("--") => index += 1,
            value => {
                positional.push(value.to_owned());
                index += 1;
            }
        }
    }
    positional
}

fn is_memory_command(positional: &[String], stage: &str) -> bool {
    positional.len() >= 3
        && matches!(positional[0].as_str(), "cognition" | "cog")
        && positional[1] == "memory"
        && positional[2] == stage
}

fn is_memory_maintain_command(args: &[OsString]) -> bool {
    is_memory_command(&positionals(args, &["--data", "--home"]), "maintain")
}

fn is_memory_initialize_command(args: &[OsString]) -> bool {
    let positional = positionals(args, &["--data", "--home"]);
    is_memory_command(&positional, "rebuild")
        && positional
            .get(3)
            .is_some_and(|stage| stage == "initialize-empty")
}

fn is_memory_rebuild_command(args: &[OsString]) -> bool {
    let positional = positionals(
        args,
        &[
            "--data",
            "--home",
            "--generation",
            "--acceptance",
            "--expected-active",
            "--vector-repair-input",
            "--input",
            "--model",
            "--reasoning-effort",
            "--quota-fallback-model",
            "--quota-fallback-reasoning-effort",
        ],
    );
    is_memory_command(&positional, "rebuild")
        && positional.get(3).is_some_and(|stage| {
            matches!(
                stage.as_str(),
                "prepare"
                    | "build"
                    | "inspect"
                    | "validate"
                    | "activate"
                    | "rollback"
                    | "retry-failed"
                    | "set-extractor"
                    | "repair-inputs"
            )
        })
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;

    use super::Command;

    #[test]
    fn command_families_claim_their_commands_after_common_options() {
        for (args, expected) in [
            (&["schedule", "list"][..], Command::Schedule),
            (&["automation", "list"], Command::Schedule),
            (
                &[
                    "--data",
                    "/tmp/d",
                    "schedule",
                    "list",
                    "--status",
                    "active",
                    "--json",
                ],
                Command::Schedule,
            ),
            (&["schedule", "future-command"], Command::Schedule),
            (&["metrics", "tail"], Command::Observability),
            (
                &["--data", "/tmp/d", "metrics", "tail", "--lines"],
                Command::Observability,
            ),
            (&["logs"], Command::Observability),
            (&["ps"], Command::Observability),
            (&["metrics", "status"], Command::Status),
            (&["search", "status", "--json"], Command::WebAccess),
            (
                &["--data", "/tmp/d", "search", "test", "rust", "async"],
                Command::WebAccess,
            ),
            (
                &["web", "read", "https://example.com", "--data", "/tmp/d"],
                Command::WebAccess,
            ),
            (&["personalization"], Command::Personalization),
            (
                &["--data", "/tmp/d", "personalization", "show"],
                Command::Personalization,
            ),
            (
                &["personalization", "migrate", "import", "--stdin"],
                Command::Personalization,
            ),
            (&["start", "--dry-run"], Command::ServiceControl),
            (&["--data", "/tmp/d", "--json"], Command::ServiceControl),
            (
                &["service", "run", "--data", "/tmp/d"],
                Command::ServiceControl,
            ),
            (
                &["service", "restart-handoff", "--data", "/tmp/d", "--quiet"],
                Command::ServiceControl,
            ),
            (&["--data", "/tmp/d", "doctor", "--fix"], Command::Doctor),
            (&["--data", "/tmp/d", "gateway", "status"], Command::Gateway),
            (&["mcp", "list"], Command::Mcp),
            (&["mcp", "serve"], Command::Mcp),
            (&["mcp", "--data", "/tmp/d", "serve"], Command::Mcp),
            (&["--data", "/tmp/d", "mcp", "serve"], Command::Mcp),
            (&["--data", "mcp", "status"], Command::Status),
            (&["model", "list"], Command::Settings),
            (&["--data", "model", "model", "list"], Command::Settings),
            (
                &["--data", "/tmp/d", "model", "set", "openai/gpt-6-astra"],
                Command::Settings,
            ),
            (&["model", "status"], Command::Status),
            (&["--data", "/tmp/d", "work", "list"], Command::Work),
            (&["skills", "list"], Command::Skills),
            (
                &["cognition", "memory", "maintain"],
                Command::MemoryMaintain,
            ),
            (
                &["cognition", "memory", "rebuild", "initialize-empty"],
                Command::MemoryInitialize,
            ),
            (
                &["cognition", "memory", "rebuild", "build"],
                Command::MemoryRebuild,
            ),
            (&["oauth-login"], Command::OauthLogin),
            (&[], Command::RunService),
            (&["nonsense"], Command::Unexpected),
        ] {
            let args: Vec<OsString> = args.iter().map(OsString::from).collect();
            assert_eq!(Command::classify(&args), expected, "{args:?}");
        }
    }
}
