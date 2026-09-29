//! The Unix hosts: launchd on macOS, systemd's user instance elsewhere.

use std::io;
use std::path::Path;
use std::process::{Command, Output};

use super::Error;

#[cfg(target_os = "macos")]
pub(super) use super::launchd::manage::{
    MANAGER, definition_path, install, is_owned_by, job, restart, start, status, stop, uninstall,
};
#[cfg(not(target_os = "macos"))]
pub(super) use super::systemd::manage::{
    MANAGER, definition_path, install, is_owned_by, job, restart, start, status, stop, uninstall,
};

pub(super) fn run(program: &str, args: &[&str]) -> io::Result<Output> {
    Command::new(program).args(args).output()
}

/// Runs a manager command that must succeed.
pub(super) fn run_checked(program: &str, args: &[&str]) -> Result<(), Error> {
    let output = run(program, args)?;
    if output.status.success() {
        return Ok(());
    }
    let mut message = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    if message.is_empty() {
        message = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    }
    if message.is_empty() {
        message = format!("exited with {}", output.status);
    }
    Err(Error::Manager {
        command: format!("{program} {}", args.join(" ")),
        message,
    })
}

/// Writes a definition atomically, readable by everyone.
pub(super) fn write_definition(path: &Path, text: &str) -> Result<(), Error> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let staging = path.with_extension(format!("tmp-{}", std::process::id()));
    std::fs::write(&staging, text)?;
    if let Err(error) = std::fs::rename(&staging, path) {
        let _ = std::fs::remove_file(&staging);
        return Err(error.into());
    }
    Ok(())
}

/// Removes a definition file; whether one was there.
pub(super) fn remove_definition(path: &Path) -> Result<bool, Error> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

/// The definition file's text; `None` when there is no file.
pub(super) fn read_definition(path: &Path) -> Result<Option<String>, Error> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}
