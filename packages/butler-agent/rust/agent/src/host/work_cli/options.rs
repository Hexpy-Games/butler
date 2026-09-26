use std::{ffi::OsString, path::PathBuf};

use super::{ResolvedInstallation, output};

pub(super) struct Options {
    pub args: Vec<String>,
    pub data: Option<String>,
    pub json: bool,
    pub quiet: bool,
    pub debug: bool,
    pub yes: bool,
    pub status: Option<String>,
}

impl Options {
    pub(super) fn command_name(&self) -> String {
        let subcommand = self.args.get(1).map(String::as_str).unwrap_or("dashboard");
        format!("butler work {subcommand}")
    }
}

pub(super) fn recognizes(args: &[OsString]) -> bool {
    let mut index = 0;
    while index < args.len() {
        match args[index].to_string_lossy().as_ref() {
            "--data" | "--home" | "--status" => index += 2,
            "--json" | "--quiet" | "--silent" | "--verbose" | "--yes" | "--non-interactive"
            | "--debug" => index += 1,
            value if value.starts_with('-') => return false,
            value => return value == "work",
        }
    }
    false
}

pub(super) fn parse(raw_args: Vec<OsString>) -> Result<Options, output::CommandError> {
    let raw = raw_args
        .into_iter()
        .map(|arg| {
            arg.into_string()
                .map_err(|_| output::failure("invalid_arguments", "arguments must be UTF-8", 2))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut args = Vec::new();
    let mut data = None;
    let mut json = false;
    let mut quiet = false;
    let mut debug = false;
    let mut yes = false;
    let mut status = None;
    let mut index = 0;
    while index < raw.len() {
        match raw[index].as_str() {
            "--data" => {
                data = Some(required(&raw, index, "--data")?.to_owned());
                index += 2;
            }
            "--status" => {
                status = Some(required(&raw, index, "--status")?.to_owned());
                index += 2;
            }
            "--json" => {
                json = true;
                index += 1;
            }
            "--quiet" | "--silent" => {
                quiet = true;
                index += 1;
            }
            "--debug" => {
                debug = true;
                index += 1;
            }
            "--yes" | "--non-interactive" => {
                yes = true;
                index += 1;
            }
            "--verbose" => index += 1,
            "--home" => {
                return Err(output::failure(
                    "invalid_arguments",
                    "--home cannot override immutable installation resources",
                    2,
                ));
            }
            value if value.starts_with('-') => {
                return Err(output::failure(
                    "invalid_arguments",
                    format!("unsupported option: {value}"),
                    2,
                ));
            }
            _ => {
                args.push(raw[index].clone());
                index += 1;
            }
        }
    }
    if args.first().map(String::as_str) != Some("work") {
        return Err(output::failure(
            "invalid_arguments",
            "expected work command",
            2,
        ));
    }
    Ok(Options {
        args,
        data,
        json,
        quiet,
        debug,
        yes,
        status,
    })
}

fn required<'a>(
    args: &'a [String],
    index: usize,
    name: &str,
) -> Result<&'a str, output::CommandError> {
    args.get(index + 1)
        .filter(|value| !value.starts_with("--"))
        .map(String::as_str)
        .ok_or_else(|| output::failure("invalid_arguments", format!("{name} requires a value"), 2))
}

pub(super) fn resolve_data_root(
    installation: &ResolvedInstallation,
    explicit: Option<&str>,
) -> Result<PathBuf, output::CommandError> {
    let requested = explicit
        .map(expand_home)
        .or_else(|| {
            std::env::var("BUTLER_DATA")
                .ok()
                .filter(|value| !value.is_empty())
                .map(|value| expand_home(&value))
        })
        .unwrap_or_else(|| user_home().join(".butler"));
    installation.validate_data_root(&requested).map_err(|_| {
        output::failure(
            "native_path_configuration_invalid",
            "Butler DATA path is unavailable or overlaps the installation.",
            2,
        )
    })
}

fn expand_home(value: &str) -> PathBuf {
    if value == "~" {
        return user_home();
    }
    value
        .strip_prefix("~/")
        .map(|rest| user_home().join(rest))
        .unwrap_or_else(|| PathBuf::from(value))
}

fn user_home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default()
}
