//! Standalone native Butler service with immutable executable-relative resources.

#[cfg(unix)]
#[tokio::main]
async fn main() -> std::process::ExitCode {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    // Internal child mode. It must not resolve installation resources or start
    // the service before the first private embedding request.
    if args.len() == 1 && args[0] == "--private-embedding-worker" {
        return butler_agent::run_private_embedding_worker().await;
    }
    let (installation, command) = match installation(&args) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("{error}");
            return std::process::ExitCode::from(2);
        }
    };
    if butler_agent::native_conversation_recovery_cli_recognizes(&command) {
        return butler_agent::run_native_conversation_recovery_cli(installation, command).await;
    }
    if butler_agent::native_public_cli_recognizes(&command) {
        return butler_agent::run_native_public_cli(installation, command).await;
    }
    if butler_agent::native_service_cli_recognizes(&command) {
        return butler_agent::run_native_service_cli(installation, command).await;
    }
    if butler_agent::native_doctor_cli_recognizes(&command) {
        return butler_agent::run_native_doctor_cli(installation, command).await;
    }
    if butler_agent::native_mcp_cli_recognizes(&command) {
        return butler_agent::run_native_mcp_cli(installation, command).await;
    }
    if butler_agent::native_personalization_cli_recognizes(&command) {
        return butler_agent::run_native_personalization_cli(installation, command).await;
    }
    if butler_agent::native_settings_cli_recognizes(&command) {
        return butler_agent::run_native_settings_cli(installation, command).await;
    }
    if butler_agent::native_observability_cli_recognizes(&command) {
        return butler_agent::run_native_observability_cli(installation, command).await;
    }
    if butler_agent::native_web_access_cli_recognizes(&command) {
        return butler_agent::run_native_web_access_cli(installation, command).await;
    }
    if butler_agent::native_automation_cli_recognizes(&command) {
        return butler_agent::run_native_automation_cli(installation, command).await;
    }
    if butler_agent::native_update_cli_recognizes(&command) {
        return butler_agent::run_native_update_cli(installation, command).await;
    }
    if butler_agent::native_status_cli_recognizes(&command) {
        return butler_agent::run_native_status_cli(installation, command).await;
    }
    if butler_agent::native_context_cli_recognizes(&command) {
        return butler_agent::run_native_context_cli(installation, command).await;
    }
    if butler_agent::native_transport_cli_recognizes(&command) {
        return butler_agent::run_native_transport_cli(installation, command).await;
    }
    if butler_agent::native_gateway_cli_recognizes(&command) {
        return butler_agent::run_native_gateway_cli(installation, command).await;
    }
    if butler_agent::native_work_cli_recognizes(&command) {
        let result = butler_agent::run_native_work_cli(installation, command).await;
        print!("{}", result.stdout);
        eprint!("{}", result.stderr);
        return std::process::ExitCode::from(result.exit_code);
    }
    if is_skills_command(&command) {
        let result = butler_agent::run_native_skills_cli(installation, command).await;
        print!("{}", result.stdout);
        eprint!("{}", result.stderr);
        return std::process::ExitCode::from(result.exit_code);
    }
    if is_cognition_command(&command) {
        if butler_agent::native_cognition_operator_cli_recognizes(&command) {
            return butler_agent::run_native_cognition_operator_cli(installation, command).await;
        }
        if is_memory_initialize_command(&command) {
            let result =
                butler_agent::run_native_memory_initialize_cli(installation, command).await;
            print!("{}", result.stdout);
            eprint!("{}", result.stderr);
            return std::process::ExitCode::from(result.exit_code);
        }
        if is_memory_rebuild_command(&command) {
            let result = butler_agent::run_native_memory_rebuild_cli(installation, command).await;
            print!("{}", result.stdout);
            eprint!("{}", result.stderr);
            return std::process::ExitCode::from(result.exit_code);
        }
        if is_memory_maintain_command(&command) {
            let result = butler_agent::run_native_memory_maintain_cli(installation, command).await;
            print!("{}", result.stdout);
            eprint!("{}", result.stderr);
            return std::process::ExitCode::from(result.exit_code);
        }
        let result = butler_agent::run_native_consolidation_cli(installation, command).await;
        print!("{}", result.stdout);
        eprint!("{}", result.stderr);
        return std::process::ExitCode::from(result.exit_code);
    }
    if command.len() == 1 && command[0] == "oauth-login" {
        return match butler_agent::run_native_oauth_login(installation).await {
            Ok(()) => std::process::ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("{error}");
                std::process::ExitCode::FAILURE
            }
        };
    }
    if !command.is_empty() {
        eprintln!("Unexpected argument. Use --help for service startup.");
        return std::process::ExitCode::from(2);
    }
    match butler_agent::run_native_service(installation).await {
        Ok(session) => {
            println!("{session}");
            std::process::ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("{error}");
            std::process::ExitCode::FAILURE
        }
    }
}

#[cfg(unix)]
fn is_skills_command(args: &[std::ffi::OsString]) -> bool {
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

#[cfg(unix)]
fn is_cognition_command(args: &[std::ffi::OsString]) -> bool {
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

#[cfg(unix)]
fn is_memory_maintain_command(args: &[std::ffi::OsString]) -> bool {
    let mut positional = Vec::new();
    let mut index = 0;
    while index < args.len() {
        match args[index].to_string_lossy().as_ref() {
            "--data" | "--home" => index += 2,
            value if value.starts_with("--") => index += 1,
            value => {
                positional.push(value.to_owned());
                index += 1;
            }
        }
    }
    positional.len() >= 3
        && matches!(positional[0].as_str(), "cognition" | "cog")
        && positional[1] == "memory"
        && positional[2] == "maintain"
}

#[cfg(unix)]
fn is_memory_initialize_command(args: &[std::ffi::OsString]) -> bool {
    let mut positional = Vec::new();
    let mut index = 0;
    while index < args.len() {
        match args[index].to_string_lossy().as_ref() {
            "--data" | "--home" => index += 2,
            value if value.starts_with("--") => index += 1,
            value => {
                positional.push(value.to_owned());
                index += 1;
            }
        }
    }
    positional.len() >= 4
        && matches!(positional[0].as_str(), "cognition" | "cog")
        && positional[1] == "memory"
        && positional[2] == "rebuild"
        && positional[3] == "initialize-empty"
}

#[cfg(unix)]
fn is_memory_rebuild_command(args: &[std::ffi::OsString]) -> bool {
    let mut positional = Vec::new();
    let mut index = 0;
    while index < args.len() {
        match args[index].to_string_lossy().as_ref() {
            "--data"
            | "--home"
            | "--generation"
            | "--acceptance"
            | "--expected-active"
            | "--vector-repair-input"
            | "--input"
            | "--model"
            | "--reasoning-effort"
            | "--quota-fallback-model"
            | "--quota-fallback-reasoning-effort" => index += 2,
            value if value.starts_with("--") => index += 1,
            value => {
                positional.push(value.to_owned());
                index += 1;
            }
        }
    }
    positional.len() >= 4
        && matches!(positional[0].as_str(), "cognition" | "cog")
        && positional[1] == "memory"
        && positional[2] == "rebuild"
        && matches!(
            positional[3].as_str(),
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
}

#[cfg(unix)]
fn installation(
    args: &[std::ffi::OsString],
) -> Result<(butler_agent::ResolvedInstallation, Vec<std::ffi::OsString>), String> {
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
                    root = Some(std::path::PathBuf::from(value));
                } else {
                    resources = Some(std::path::PathBuf::from(value));
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
        (None, None) => butler_agent::ResolvedInstallation::standalone()?,
        (Some(root), Some(resources)) => butler_agent::ResolvedInstallation::desktop(
            std::env::current_exe().map_err(|error| error.to_string())?,
            root,
            resources,
        )?,
        (None, Some(_)) => return Err("--installation-root is required".to_owned()),
        (Some(_), None) => return Err("--resource-root is required".to_owned()),
    };
    Ok((installation, command))
}

#[cfg(all(test, unix))]
mod tests {
    use std::ffi::OsString;

    type Recognizer = fn(&[OsString]) -> bool;

    /// Mirrors the dispatch order of `main`: the first family that claims argv runs.
    fn route(args: &[OsString]) -> &'static str {
        let families: [(&str, Recognizer); 18] = [
            (
                "conversation_recovery",
                butler_agent::native_conversation_recovery_cli_recognizes,
            ),
            ("public", butler_agent::native_public_cli_recognizes),
            ("service", butler_agent::native_service_cli_recognizes),
            ("doctor", butler_agent::native_doctor_cli_recognizes),
            ("mcp", butler_agent::native_mcp_cli_recognizes),
            (
                "personalization",
                butler_agent::native_personalization_cli_recognizes,
            ),
            ("settings", butler_agent::native_settings_cli_recognizes),
            (
                "observability",
                butler_agent::native_observability_cli_recognizes,
            ),
            ("web_access", butler_agent::native_web_access_cli_recognizes),
            ("automation", butler_agent::native_automation_cli_recognizes),
            ("update", butler_agent::native_update_cli_recognizes),
            ("status", butler_agent::native_status_cli_recognizes),
            ("context", butler_agent::native_context_cli_recognizes),
            ("transport", butler_agent::native_transport_cli_recognizes),
            ("gateway", butler_agent::native_gateway_cli_recognizes),
            ("work", butler_agent::native_work_cli_recognizes),
            ("skills", super::is_skills_command),
            ("cognition", super::is_cognition_command),
        ];
        families
            .iter()
            .find(|(_, recognizes)| recognizes(args))
            .map_or("none", |(name, _)| name)
    }

    #[test]
    fn command_families_claim_their_commands_after_common_options() {
        for (args, expected) in [
            (&["automation", "list"][..], "automation"),
            (
                &[
                    "--data",
                    "/tmp/d",
                    "automation",
                    "list",
                    "--status",
                    "active",
                    "--json",
                ],
                "automation",
            ),
            (&["automation", "future-command"], "automation"),
            (&["metrics", "tail"], "observability"),
            (
                &["--data", "/tmp/d", "metrics", "tail", "--lines"],
                "observability",
            ),
            (&["logs"], "observability"),
            (&["ps"], "observability"),
            (&["metrics", "status"], "status"),
            (&["search", "status", "--json"], "web_access"),
            (
                &["--data", "/tmp/d", "search", "test", "rust", "async"],
                "web_access",
            ),
            (
                &["web", "read", "https://example.com", "--data", "/tmp/d"],
                "web_access",
            ),
            (&["personalization"], "personalization"),
            (
                &["--data", "/tmp/d", "personalization", "show"],
                "personalization",
            ),
            (
                &["personalization", "migrate", "import", "--stdin"],
                "personalization",
            ),
            (&["start", "--dry-run"], "service"),
            (&["--data", "/tmp/d", "--json"], "service"),
            (&["service", "run", "--data", "/tmp/d"], "service"),
            (
                &["service", "restart-handoff", "--data", "/tmp/d", "--quiet"],
                "service",
            ),
            (&["--data", "/tmp/d", "doctor", "--fix"], "doctor"),
            (&["--data", "/tmp/d", "gateway", "status"], "gateway"),
            (&["mcp", "list"], "mcp"),
            (&["mcp", "serve"], "mcp"),
            (&["mcp", "--data", "/tmp/d", "serve"], "mcp"),
            (&["--data", "/tmp/d", "mcp", "serve"], "mcp"),
            (&["--data", "mcp", "status"], "status"),
            (&["model", "list"], "settings"),
            (&["--data", "model", "model", "list"], "settings"),
            (
                &["--data", "/tmp/d", "model", "set", "openai/gpt-6-astra"],
                "settings",
            ),
            (&["model", "status"], "status"),
            (&["--data", "/tmp/d", "work", "list"], "work"),
            (&["skills", "list"], "skills"),
            (&["cognition", "memory", "maintain"], "cognition"),
        ] {
            let args: Vec<OsString> = args.iter().map(OsString::from).collect();
            assert_eq!(route(&args), expected, "{args:?}");
        }
    }
}

#[cfg(not(unix))]
fn main() {
    eprintln!("The native service host for this platform is not yet available.");
    std::process::exit(1);
}
