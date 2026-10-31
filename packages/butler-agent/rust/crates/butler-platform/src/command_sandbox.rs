//! The shells commands run in and the sandboxes that bound what they can do.
//!
//! macOS uses Seatbelt; Linux uses a single-threaded Landlock/seccomp
//! trampoline. Unsupported hosts keep exact-action approval behavior.

mod denial;
pub use denial::{
    EXECUTION_FAILURE_EXIT, EXECUTION_FAILURE_MARKER, EXECUTION_TIMEOUT_EXIT,
    EXECUTION_TIMEOUT_MARKER, execution_failure, execution_failure_exit, execution_timeout,
    execution_timeout_exit, isolation_failure, isolation_failure_exit, sandbox_denial,
};
mod credentials;
mod hook_containment;
pub use hook_containment::{
    ContainedHook, HookContainment, HookSandbox, contain_hook, hook_invocation, powershell_literal,
};
pub mod mxc_policy;
mod project_secrets;
pub use credentials::secret_name;
pub use project_secrets::{
    ProjectEntries, discover_project_entries, discover_project_secrets, prewarm_project,
    sweep_new_secrets, sweep_with_inventory,
};
mod environment;
pub use environment::tool_environment;
mod operators;
mod output;
pub use output::CommandOutputDecoder;
mod path_candidates;
pub use path_candidates::{path_script, path_tokens};

/// Escape character interpreted by the platform command shell.
pub const SHELL_ESCAPE: char = shell::ESCAPE;

use std::collections::HashMap;
use std::path::Path;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use macos as sandbox;
#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
mod unsandboxed;
#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
use unsandboxed as sandbox;

#[cfg(unix)]
mod unix;
#[cfg(unix)]
use unix as shell;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as shell;
#[cfg(windows)]
use windows::mxc as sandbox;

#[cfg(feature = "test-support")]
pub use test_support::installation::FixtureInstallation;

/// Native shell fixtures for command lifecycle tests.
#[cfg(feature = "test-support")]
#[path = "command_sandbox/test_support/commands.rs"]
pub mod command_fixtures;
#[cfg(feature = "test-support")]
mod test_support;
#[cfg(feature = "test-support")]
pub use test_support::ledger::WindowsLedger;
#[cfg(feature = "test-support")]
pub use test_support::{
    UnixSocketProbe, linux_syscall_probe, linux_test_host, windows_prepare_project_write,
    windows_recovery_contract, windows_shell_file_contract, wsl_test_host,
};

#[cfg(all(feature = "test-support", target_os = "linux"))]
pub use linux::verify_mount_plan_contract;

mod host_capabilities;
pub use host_capabilities::{Level, SandboxCapabilities, cached_capabilities, capabilities};
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
use linux as sandbox;

/// Whether contained observations can run without exact-action approval.
pub fn approval_free_reads() -> bool {
    capabilities().approval_free_reads()
}

/// Whether [`project_write_shell`] can contain a mutating command to its
/// project (writes inside the project only, no network).
pub fn project_write_available() -> bool {
    capabilities().project_write_available()
}

/// Whether the kernel can keep Butler's secrets and the user's credential
/// stores unreadable to an approved command that otherwise runs with the
/// user's access ([`deny_secret_reads`]). macOS only: Landlock cannot
/// subtract a folder without also hiding files the command creates next to
/// it, and Windows containment confines writes to the project.
pub fn secret_reads_deniable() -> bool {
    #[cfg(feature = "test-support")]
    if std::env::var("BUTLER_TEST_SECRET_READ_DENIAL").as_deref() == Ok("unavailable") {
        return false;
    }
    cfg!(target_os = "macos")
}

/// What [`deny_secret_reads`] withholds, for a command that failed under it.
pub const SECRET_READ_LIMITS: &str = "This command ran with the user's access, except that credential stores (such as ~/.ssh and ~/.aws) and Butler's own secret files were unreadable and could not be moved or changed. SSH authenticates only through a running SSH agent. If it needs those files, run it again with sandbox \"none\"; the user will be asked each time.";

/// `invocation` with every credential root (the one policy behind
/// `SecretInventory`) unreadable, unwritable and unmovable, by path and by
/// real path, and with writes below `write_protected` denied. Writes
/// elsewhere and network stay the user's. Hosts without
/// [`secret_reads_deniable`] refuse it.
pub fn deny_secret_reads(
    invocation: Invocation,
    environment: &HashMap<String, String>,
    write_protected: Option<&Path>,
) -> Result<Invocation, SandboxError> {
    if !secret_reads_deniable() {
        return Err(SandboxError::SecretReadsUnavailable);
    }
    #[cfg(target_os = "macos")]
    return macos::deny_secret_reads(invocation, environment, write_protected);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (invocation, environment, write_protected);
        Err(SandboxError::SecretReadsUnavailable)
    }
}

/// Mechanism used by project-write containment; availability is probed separately.
pub const fn project_write_mechanism() -> &'static str {
    if cfg!(target_os = "macos") {
        "seatbelt"
    } else if cfg!(target_os = "linux") {
        "landlock"
    } else if cfg!(windows) {
        "mxc_base_container"
    } else {
        "unavailable"
    }
}

/// Host-specific limits reported after a failed contained command.
pub fn project_write_limits() -> &'static str {
    #[cfg(target_os = "linux")]
    if linux::metadata_tier_available() {
        return "This command ran contained to the project folder: no writes elsewhere, no network, and existing secrets are masked. New secret names are swept after the run. If it needs more access, run it again with sandbox \"none\"; the user will be asked.";
    }
    #[cfg(target_os = "linux")]
    if linux::mount_tier_available() {
        return "This command ran contained to the project folder: no writes elsewhere, no network, and existing secrets are masked. New secret names are swept after the run. Metadata changes are blocked. If it needs more access, run it again with sandbox \"none\"; the user will be asked.";
    }
    if cfg!(target_os = "linux") || cfg!(target_os = "macos") {
        "This command ran contained to the project folder: no writes elsewhere (including .git and existing secrets) and no network. Creating, deleting or renaming top-level project entries is also blocked. If it needs those, run it again with sandbox \"none\"; the user will be asked."
    } else {
        "This command ran contained to the project folder: no writes elsewhere (including .git and existing secrets) and no network. New secret names are swept after the run. If it needs more access, run it again with sandbox \"none\"; the user will be asked."
    }
}

/// Entry point of the single-threaded trampoline, never called by the agent.
#[cfg(target_os = "linux")]
pub fn trampoline() -> Result<(), Box<dyn std::error::Error>> {
    linux::trampoline()
}

/// Whether [`login_shell`] runs commands in a POSIX shell (`sh -c`); Windows
/// runs them in Windows PowerShell 5.1, whose syntax differs.
pub const POSIX_SHELL: bool = shell::POSIX;

/// A program and its arguments.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Invocation {
    /// The executable to start.
    pub program: String,
    /// Its arguments, in order.
    pub arguments: Vec<String>,
    /// Inner shell path when the platform needs a process startup wrapper.
    /// Passed through the environment, never interpolated into shell syntax.
    pub shell_program: Option<String>,
    /// Script carried outside the startup wrapper's command line length limit.
    pub shell_script: Option<String>,
    /// Keeps per-command preparation live until dispatch and execution finish.
    pub lease: Option<std::sync::Arc<InvocationLease>>,
}

/// An opaque preparation lease; closing it permits subsequent reconciliation.
#[derive(Debug)]
pub struct InvocationLease {
    _file: std::fs::File,
    path: std::path::PathBuf,
}
impl PartialEq for InvocationLease {
    fn eq(&self, other: &Self) -> bool {
        self.path == other.path
    }
}
impl Eq for InvocationLease {}

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
    /// This host cannot contain a mutating command to its project.
    #[error("this host cannot contain commands to the project folder")]
    ProjectWriteUnavailable,
    /// This host cannot keep credential stores unreadable to approved commands.
    #[error("this host cannot deny credential reads to approved commands")]
    SecretReadsUnavailable,
    /// The project inventory is still building or being verified.
    #[error("project write inventory pending")]
    ProjectWritePending,
    /// Filesystem discovery or policy preparation failed; never run uncontained.
    #[error("sandbox filesystem preparation failed: {0}")]
    Filesystem(#[from] std::io::Error),
    /// The read-deny paths could not be quoted into the sandbox profile.
    #[error("sandbox profile encoding failed")]
    Profile(#[from] serde_json::Error),
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
/// on Unix and Windows PowerShell 5.1 on Windows. Explicit `cmd /c` scripts
/// use `%ComSpec% /d /s /c` (read from `environment`).
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
        ShellAccess::ReadOnly => sandbox::read_only_contained(invocation, environment, &[], &[]),
    }
}

/// Read-only shell with denied private roots and an explicit project exception.
pub fn login_shell_contained(
    command: &str,
    environment: &HashMap<String, String>,
    deny_reads: &[&Path],
    allow_reads: &[&Path],
) -> Result<Invocation, SandboxError> {
    sandbox::read_only_contained(
        shell::login_shell(command, environment),
        environment,
        deny_reads,
        allow_reads,
    )
}

/// `invocation` inside the read-only sandbox, with `root` readable. Hosts without one
/// refuse it. Never start the invocation unwrapped instead.
pub(crate) fn read_only_invocation(
    invocation: Invocation,
    environment: &HashMap<String, String>,
    root: &Path,
) -> Result<Invocation, SandboxError> {
    sandbox::read_only_contained(invocation, environment, &[], &[root])
}

/// `invocation` inside the project-write sandbox; see [`project_write_shell`].
pub(crate) fn project_write_invocation(
    invocation: Invocation,
    environment: &HashMap<String, String>,
    root: &Path,
    writable: &[&Path],
    denied: &[&Path],
    toolchain_roots: Option<&ToolchainRoots>,
) -> Result<Invocation, SandboxError> {
    sandbox::project_write(
        invocation,
        environment,
        root,
        writable,
        denied,
        toolchain_roots,
    )
}

/// Account folders supplied by the caller for installed toolchain discovery.
/// These may differ from the command's redirected profile environment.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolchainRoots {
    /// The account home containing default Cargo and Rustup installations.
    pub home: std::path::PathBuf,
    /// Roaming application installations.
    pub app_data: std::path::PathBuf,
    /// Machine-local application installations.
    pub local_app_data: std::path::PathBuf,
}

/// The login shell of a mutating command contained to `root`: it may write
/// only inside `root` and the `writable` scratch roots, never below `denied`
/// or to project metadata and secrets, may not read credential stores, and
/// has no network. Hosts without [`project_write_available`] refuse it.
/// `toolchain_roots` names installed tools independently of the command profile;
/// when unavailable, discovery falls back to the supplied environment.
pub fn project_write_shell(
    command: &str,
    environment: &HashMap<String, String>,
    root: &Path,
    writable: &[&Path],
    denied: &[&Path],
    toolchain_roots: Option<&ToolchainRoots>,
) -> Result<Invocation, SandboxError> {
    sandbox::project_write(
        shell::login_shell(command, environment),
        environment,
        root,
        writable,
        denied,
        toolchain_roots,
    )
}

/// Adds the arguments of `invocation` to `command`, which starts its
/// program. Windows passes the text `cmd.exe /d /s /c` runs verbatim between
/// one pair of quotes: `cmd` does not undo the `\"` escaping that
/// `Command::arg` applies, so a command containing quotes would reach it
/// mangled.
/// Configure the environment and working directory first; PowerShell also
/// restores its provider location to that same admitted directory.
pub fn add_arguments(command: &mut std::process::Command, invocation: &Invocation) {
    shell::add_arguments(command, invocation);
}

/// The same admitted directory in a form the native process launcher accepts.
/// Call off async workers: Windows may query short names for long directories.
pub fn working_directory(path: &Path) -> std::io::Result<std::path::PathBuf> {
    shell::working_directory(path)
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

/// Whether an unquoted shell operator could detach work. Interpreter script
/// arguments remain quoted data; shell escape syntax is host-specific.
pub fn has_background_operator(command: &str) -> bool {
    operators::has_background(command, shell::ESCAPE)
}

/// Whether a shell path names the registry instead of the filesystem.
/// Used by lexical command guards; this does not authorize registry writes.
pub fn is_registry_path(path: &str) -> bool {
    shell::is_registry_path(path)
}

/// Normalize host path separators without interpreting POSIX shell escapes
/// such as a quoted `printf` newline as a filesystem separator.
pub fn normalize_path_token(path: &str) -> String {
    shell::normalize_path_token(path)
}

/// Saves this process's sandbox probe as a startup hint in `data`. Probing
/// itself never writes, so call this only once the host has accepted `data`;
/// call off async workers.
pub fn remember_probe(data: &Path) {
    #[cfg(target_os = "linux")]
    linux::remember_probe(data);
    #[cfg(not(target_os = "linux"))]
    let _ = data;
}

/// Reclaims helper-owned drive mappings after reap or at startup; call off async workers.
pub fn reconcile_project_write(data: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    return windows::mxc::reconcile(data);
    #[cfg(not(windows))]
    {
        let _ = data;
        Ok(())
    }
}
/// Windows helper entry point; the agent never calls PSEC directly.
#[cfg(windows)]
pub fn windows_sandbox_helper() -> Result<i32, Box<dyn std::error::Error>> {
    windows::mxc::launch::main()
}

/// Holds a project-write setup/cleanup lease across the command lifetime.
pub struct ProjectWritePreparation {
    #[cfg(target_os = "linux")]
    _lease: nix::fcntl::Flock<std::fs::File>,
}

impl ProjectWritePreparation {
    /// Consumes the preparation, releasing any platform lease after cleanup.
    pub fn release(self) {}
}

/// Prepares declared generated directories where the project root is withheld.
pub fn prepare_project_write(root: &Path, data: &Path) -> std::io::Result<ProjectWritePreparation> {
    #[cfg(target_os = "linux")]
    return linux::prepare_project_write(root, data);
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (root, data);
        Ok(ProjectWritePreparation {})
    }
}

/// Namespace aliases for kernel-boundary E2E checks.
#[cfg(feature = "test-support")]
pub fn project_mount_aliases(root: &Path) -> std::io::Result<Vec<std::path::PathBuf>> {
    #[cfg(target_os = "linux")]
    return linux::project_mount_aliases(root);
    #[cfg(not(target_os = "linux"))]
    Ok(vec![root.to_path_buf()])
}

/// Releases per-command preparation after execution or when the helper never starts.
/// Call off runtime workers; running helpers retain ownership of their files.
pub fn cleanup_prepared_invocation(invocation: &Invocation) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        windows::mxc::prepare::cleanup_invocation(invocation)
    }
    #[cfg(not(windows))]
    {
        let _ = invocation;
        Ok(())
    }
}
