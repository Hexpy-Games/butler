//! The shells commands run in and the sandboxes that bound what they can do.
//!
//! macOS enforces read-only commands and write-protected roots with the
//! seatbelt (`sandbox-exec`). Linux and Windows have no sandbox yet: they
//! refuse read-only commands ([`SandboxError::ReadOnlyUnavailable`]) and
//! report write protection as [`Protection::Unavailable`]. Linux gets a
//! Landlock wrapper in a later stage.

use std::collections::HashMap;
use std::path::Path;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use macos as sandbox;
#[cfg(not(target_os = "macos"))]
mod unsandboxed;
#[cfg(not(target_os = "macos"))]
use unsandboxed as sandbox;

#[cfg(unix)]
mod unix;
#[cfg(unix)]
use unix as shell;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as shell;

/// Whether this host runs [`ShellAccess::ReadOnly`] commands in a sandbox
/// (otherwise [`login_shell`] refuses them).
pub const READ_ONLY_SANDBOX: bool = sandbox::ENFORCED;

/// Whether [`protect_writes`] enforces its root on this host.
pub const WRITE_PROTECTION: bool = sandbox::ENFORCED;

/// Whether [`login_shell`] runs commands in a POSIX shell (`sh -c`); Windows
/// runs them in `cmd.exe`, whose syntax differs.
pub const POSIX_SHELL: bool = shell::POSIX;

/// A program and its arguments.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Invocation {
    /// The executable to start.
    pub program: String,
    /// Its arguments, in order.
    pub arguments: Vec<String>,
}

/// What a shell command may do.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShellAccess {
    /// Anything the user may do.
    Full,
    /// Observe only: no file writes (other than `/dev/null`) and no network.
    ReadOnly,
}

/// Why a command cannot run with the requested access.
#[derive(Debug, thiserror::Error)]
pub enum SandboxError {
    /// This host cannot enforce [`ShellAccess::ReadOnly`].
    #[error("this host cannot enforce read-only commands")]
    ReadOnlyUnavailable,
}

/// Why a write-protected invocation could not be built.
#[derive(Debug, thiserror::Error)]
pub enum ProtectError {
    /// The protected root could not be quoted into the sandbox profile.
    #[error(transparent)]
    Profile(serde_json::Error),
}

/// An invocation after [`protect_writes`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Protection {
    /// It runs in a sandbox that denies writes below the root.
    Enforced(Invocation),
    /// This host has no write protection; the invocation is unchanged.
    Unavailable(Invocation),
}

/// The login-shell invocation of a user command with `access`: `/bin/sh -lc`
/// on Unix and `%ComSpec% /d /s /c` on Windows (read from `environment`).
/// Read-only commands run inside the host sandbox, and hosts without one
/// refuse them.
pub fn login_shell(
    command: &str,
    access: ShellAccess,
    environment: &HashMap<String, String>,
) -> Result<Invocation, SandboxError> {
    let invocation = shell::login_shell(command, environment);
    match access {
        ShellAccess::Full => Ok(invocation),
        ShellAccess::ReadOnly => sandbox::read_only(invocation),
    }
}

/// Adds the arguments of `invocation` to `command`, which starts its
/// program. Windows passes the text `cmd.exe /d /s /c` runs verbatim between
/// one pair of quotes: `cmd` does not undo the `\"` escaping that
/// `Command::arg` applies, so a command containing quotes would reach it
/// mangled.
pub fn add_arguments(command: &mut std::process::Command, invocation: &Invocation) {
    shell::add_arguments(command, invocation);
}

/// The shell of legacy compatibility commands: `/bin/bash [-o pipefail] -lc`
/// on Unix and PowerShell on Windows (`BUTLER_POWERSHELL` in `environment`
/// overrides `powershell.exe`).
pub fn legacy_shell(
    command: &str,
    pipefail: bool,
    environment: &HashMap<String, Option<String>>,
) -> Invocation {
    shell::legacy_shell(command, pipefail, environment)
}

/// Wraps `invocation` so it cannot write below `root`, by the given path and
/// by its real path. `root` must be absolute and lexically normalized.
pub fn protect_writes(invocation: Invocation, root: &Path) -> Result<Protection, ProtectError> {
    sandbox::protect_writes(invocation, root)
}
