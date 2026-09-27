use std::ffi::OsString;

use super::{CliError, Command, positionals_without_options};

pub(super) fn required_value<'a>(
    args: &'a [OsString],
    index: usize,
    name: &str,
) -> Result<&'a OsString, (&'static str, CliError)> {
    args.get(index + 1)
        .filter(|value| !value.to_string_lossy().starts_with('-'))
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            (
                command_name_os(args),
                CliError::invalid(format!("{name} requires a value")),
            )
        })
}

pub(super) fn command_id(command: &Command) -> Option<&str> {
    match command {
        Command::Show(id) | Command::Run(id) | Command::Delete(id) => Some(id),
        Command::List | Command::MissingId(_) | Command::Unknown => None,
    }
}

pub(super) fn valid_id(id: &str) -> bool {
    let value = id.trim();
    (1..=100).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
}

pub(super) fn command_name(values: &[String]) -> &'static str {
    match values.get(1).map(String::as_str) {
        Some("list") => "butler automation list",
        Some("show") => "butler automation show",
        Some("run") => "butler automation run",
        Some("delete") => "butler automation delete",
        _ => "butler automation",
    }
}

pub(super) fn command_name_os(args: &[OsString]) -> &'static str {
    command_name(&positionals_without_options(args))
}
