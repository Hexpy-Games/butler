use std::{ffi::OsString, path::PathBuf};

use super::{CliError, Command, Options};

pub(super) fn parse(
    args: &[OsString],
) -> Result<(Options, Command, String), (String, CliError, bool)> {
    let json_requested = args.iter().any(|arg| arg == "--json");
    let mut options = Options::default();
    let mut index = 0;
    while index < args.len() {
        let value = args[index].to_string_lossy();
        match value.as_ref() {
            "--data" => {
                let raw = args
                    .get(index + 1)
                    .filter(|raw| !raw.to_string_lossy().starts_with("--"))
                    .ok_or_else(|| {
                        (
                            error_command(args),
                            CliError::invalid("--data requires a path"),
                            json_requested,
                        )
                    })?;
                options.data = Some(PathBuf::from(raw.as_os_str()));
                index += 2;
                continue;
            }
            value if value.starts_with("--data=") => {
                let path = &value[7..];
                if path.is_empty() {
                    return Err((
                        error_command(args),
                        CliError::invalid("--data requires a path"),
                        json_requested,
                    ));
                }
                options.data = Some(PathBuf::from(path));
            }
            "--home" => {
                return Err((
                    error_command(args),
                    CliError::invalid("--home is unsupported; native commands use --data"),
                    json_requested,
                ));
            }
            "--session" => {
                if let Some(raw) = args
                    .get(index + 1)
                    .filter(|raw| !raw.to_string_lossy().starts_with("--"))
                {
                    options
                        .session
                        .get_or_insert_with(|| raw.to_string_lossy().into_owned());
                    index += 2;
                } else {
                    index += 1;
                }
                continue;
            }
            "--json" => options.json = true,
            "--quiet" | "--silent" => options.quiet = true,
            "--yes" => options.yes = true,
            "--verbose" => {}
            "--non-interactive" => options.non_interactive = true,
            "--status" => {
                options.status = true;
                options.operator_args.push(value.into_owned());
            }
            "--dry-run" => {
                options.dry_run = true;
                options.operator_args.push(value.into_owned());
            }
            "--apply" => {
                options.apply = true;
                options.operator_args.push(value.into_owned());
            }
            value if value.starts_with('-') => options.operator_args.push(value.to_owned()),
            _ => {
                let positional = value.into_owned();
                options.positionals.push(positional.clone());
                options.operator_args.push(positional);
            }
        }
        index += 1;
    }

    let Some((command, prefix, expected_len)) = command_prefix(&options.positionals) else {
        return Err((
            error_command(args),
            CliError::invalid(
                "supported commands: cognition memory status|project inspect|metadata inspect|repair-links|check|ingest; cognition migrate",
            ),
            json_requested,
        ));
    };
    if command == Command::ProjectInspect
        && (options.positionals.len() < expected_len
            || options.positionals.get(4).is_some_and(String::is_empty))
    {
        return Err((
            command.name(prefix),
            CliError::invalid("memory project inspect requires <project-id>"),
            json_requested,
        ));
    }
    if command == Command::Migration && !options.status && !options.dry_run && !options.apply {
        return Err((
            command.name(prefix),
            CliError::invalid("cognition migrate requires --status, --dry-run, or --apply"),
            json_requested,
        ));
    }
    if command == Command::MetadataRepairLinks && !options.yes && !options.non_interactive {
        return Err((
            command.name(prefix),
            CliError::invalid("memory metadata repair-links requires --yes"),
            json_requested,
        ));
    }
    if command == Command::MemoryIngest && options.session.is_none() {
        return Err((
            command.name(prefix),
            CliError::invalid("memory ingest requires --session SESSION_ID"),
            json_requested,
        ));
    }
    if command != Command::Migration
        && !accepts_operator_args(command)
        && options.positionals.len() != expected_len
    {
        return Err((
            command.name(prefix),
            CliError::invalid(format!("unexpected arguments for {}", command.name(prefix))),
            json_requested,
        ));
    }
    if !accepts_operator_args(command)
        && command != Command::Migration
        && args.iter().any(|arg| {
            let value = arg.to_string_lossy();
            value.starts_with('-')
                && !allowed_option(command, value.as_ref())
                && !value.starts_with("--data=")
        })
    {
        let option = args
            .iter()
            .map(|arg| arg.to_string_lossy())
            .find(|value| {
                value.starts_with('-')
                    && !allowed_option(command, value.as_ref())
                    && !value.starts_with("--data=")
            })
            .unwrap_or_default();
        return Err((
            command.name(prefix),
            CliError::invalid(format!("unsupported option: {option}")),
            json_requested,
        ));
    }
    Ok((options, command, prefix.to_owned()))
}

pub(super) fn command_prefix(values: &[String]) -> Option<(Command, &'static str, usize)> {
    let prefix = match values.first()?.as_str() {
        "cognition" => "cognition",
        "cog" => "cog",
        _ => return None,
    };
    match values.get(1..)? {
        [memory, ingest, ..] if memory == "memory" && ingest == "ingest" => {
            Some((Command::MemoryIngest, prefix, 3))
        }
        [memory, status, ..] if memory == "memory" && status == "status" => {
            Some((Command::MemoryStatus, prefix, 3))
        }
        [memory, recall, ..] if memory == "memory" && recall == "recall" => {
            Some((Command::MemoryRecall, prefix, 3))
        }
        [memory, recovery, ..] if memory == "memory" && recovery == "recovery" => {
            Some((Command::MemoryRecovery, prefix, 3))
        }
        [memory, project, inspect, ..]
            if memory == "memory" && project == "project" && inspect == "inspect" =>
        {
            Some((Command::ProjectInspect, prefix, 5))
        }
        [memory, metadata, check, ..]
            if memory == "memory" && metadata == "metadata" && check == "check" =>
        {
            Some((Command::MetadataCheck, prefix, 4))
        }
        [memory, metadata, inspect, ..]
            if memory == "memory" && metadata == "metadata" && inspect == "inspect" =>
        {
            Some((Command::MetadataInspect, prefix, 5))
        }
        [memory, metadata, repair, ..]
            if memory == "memory" && metadata == "metadata" && repair == "repair-links" =>
        {
            Some((Command::MetadataRepairLinks, prefix, 4))
        }
        [feedback, ..] if feedback == "feedback" => Some((Command::Feedback, prefix, 2)),
        [box_store, ..] if box_store == "box" => Some((Command::Box, prefix, 2)),
        [know_how, ..] if know_how == "know-how" => Some((Command::KnowHow, prefix, 2)),
        [migrate, ..] if migrate == "migrate" => Some((Command::Migration, prefix, 2)),
        _ => None,
    }
}

fn accepts_operator_args(command: Command) -> bool {
    matches!(
        command,
        Command::Feedback
            | Command::Box
            | Command::KnowHow
            | Command::MemoryRecall
            | Command::MemoryRecovery
    )
}

pub(super) fn positionals_without_options(args: &[OsString]) -> Vec<String> {
    let mut values = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let value = args[index].to_string_lossy();
        match value.as_ref() {
            "--data" | "--home" => {
                index += if args
                    .get(index + 1)
                    .is_some_and(|next| !next.to_string_lossy().starts_with("--"))
                {
                    2
                } else {
                    1
                };
            }
            "--session" => {
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
            "--json" | "--quiet" | "--silent" | "--verbose" | "--yes" | "--non-interactive"
            | "--status" | "--dry-run" | "--apply" => index += 1,
            _ => {
                values.push(value.into_owned());
                index += 1;
            }
        }
    }
    values
}

fn allowed_option(command: Command, value: &str) -> bool {
    matches!(
        value,
        "--data" | "--json" | "--quiet" | "--silent" | "--yes" | "--verbose" | "--non-interactive"
    ) || (command == Command::MemoryIngest && matches!(value, "--session" | "--dry-run"))
}

fn error_command(args: &[OsString]) -> String {
    let values = positionals_without_options(args);
    command_prefix(&values)
        .map(|(command, prefix, _)| command.name(prefix))
        .unwrap_or_else(|| "butler cognition".to_owned())
}
