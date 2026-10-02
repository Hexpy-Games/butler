//! Owner-facing child names without changing binary bytes or instance identity.
//!
//! macOS and Windows use full-name hard links. Linux uses a short basename
//! and comm, with the full name in argv[0].
mod archive;
pub use archive::restore_archive_links;

use std::{
    fs, io,
    path::{Path, PathBuf},
    process::Command,
};

/// A separate process running the Agent binary (not an in-process task).
#[derive(Clone, Copy, Debug)]
pub enum Role {
    /// Private embedding model worker.
    Memory,
    /// Service restart CLI or detached handoff.
    Restart,
    /// Install/update lifecycle CLI.
    Update,
}

impl Role {
    /// Full owner-facing command name.
    pub fn name(self) -> &'static str {
        match self {
            Self::Memory => "butler-agent (memory)",
            Self::Restart => "butler-agent (restart)",
            Self::Update => "butler-agent (update)",
        }
    }

    /// Kernel name that fits Linux's 15-byte comm limit.
    pub fn short_name(self) -> &'static str {
        match self {
            Self::Memory => "butler-memory",
            Self::Restart => "butler-restart",
            Self::Update => "butler-update",
        }
    }

    /// Executable hard-link filename for this host platform.
    pub fn file_name(self) -> &'static str {
        if cfg!(windows) {
            match self {
                Self::Memory => "butler-agent (memory).exe",
                Self::Restart => "butler-agent (restart).exe",
                Self::Update => "butler-agent (update).exe",
            }
        } else if cfg!(target_os = "macos") {
            self.name()
        } else {
            self.short_name()
        }
    }
}

const ROLES: [Role; 3] = [Role::Memory, Role::Restart, Role::Update];

/// Creates or verifies aliases before an installation becomes read-only.
/// Existing foreign entries are refused, never replaced. No binary is copied.
///
/// # Errors
/// Returns filesystem errors or `InvalidData` for a foreign alias.
// TODO(#260): Verify ReFS file identity behavior and the Windows Processes-tab
// presentation; Task Manager Details uses the role image filename.
pub fn prepare(binary: &Path) -> io::Result<()> {
    let binary = canonical_executable(binary)?;
    for role in ROLES {
        let alias = binary.with_file_name(role.file_name());
        match fs::hard_link(&binary, &alias) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
        verify_alias(&binary, &alias)?;
    }
    Ok(())
}

/// Asks a verified installation to prepare its own aliases. Older Agents
/// reject the private command with exit 2 and retain their original layout.
/// Calling the target is essential: older code cannot normalize role aliases.
///
/// # Errors
/// Returns spawn errors or a failure reported by a naming-capable Agent.
pub fn prepare_installation(binary: &Path) -> io::Result<()> {
    let status = Command::new(binary)
        .arg("--prepare-process-links")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()?;
    match status.code() {
        Some(0 | 2) => Ok(()),
        _ => Err(io::Error::other("process role preparation failed")),
    }
}

/// The verified alias to execute, or the original binary in older layouts.
/// Missing aliases preserve compatibility; a foreign alias fails closed.
///
/// # Errors
/// Returns filesystem errors or `InvalidData` for a foreign alias.
pub fn executable(binary: &Path, role: Role) -> io::Result<PathBuf> {
    let binary = canonical_executable(binary)?;
    let alias = binary.with_file_name(role.file_name());
    match fs::symlink_metadata(&alias) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(binary),
        Err(error) => Err(error),
        Ok(_) => {
            verify_alias(&binary, &alias)?;
            Ok(alias)
        }
    }
}

/// Resolves a spawn alias off the Tokio worker thread.
///
/// # Errors
/// Returns the errors of [`executable`] or a blocking-task join failure.
pub async fn executable_async(binary: &Path, role: Role) -> io::Result<PathBuf> {
    let binary = binary.to_path_buf();
    tokio::task::spawn_blocking(move || executable(&binary, role))
        .await
        .map_err(io::Error::other)?
}

fn verify_alias(binary: &Path, alias: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(alias)?;
    if !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "foreign process role alias",
        ));
    }
    #[cfg(windows)]
    let same_file = same_file::is_same_file(binary, alias)?;
    #[cfg(not(windows))]
    let same_file = crate::secure_fs::same_file(&fs::metadata(binary)?, &metadata);
    if !same_file {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "foreign process role alias",
        ));
    }
    Ok(())
}

/// Normalizes only verified role hardlinks to the installation's original path.
/// Used by executable identity queries, including proc_pidpath.
///
/// # Errors
/// Refuses a role filename that is not the same file as the original binary.
pub(crate) fn canonical_identity(path: PathBuf) -> io::Result<PathBuf> {
    let path = crate::launcher::canonical_command_executable(path)?;
    if !ROLES.iter().any(|role| {
        path.file_name()
            .is_some_and(|name| name == role.file_name())
    }) {
        return Ok(path);
    }
    let binary = path.with_file_name(crate::launcher::AGENT_BINARY);
    verify_alias(&binary, &path)?;
    Ok(binary)
}

/// This process's original executable, even when it ran through a role alias.
///
/// # Errors
/// Returns executable lookup or alias verification errors.
pub fn current_exe() -> io::Result<PathBuf> {
    canonical_identity(std::env::current_exe()?)
}

/// Resolves an executable's symlinks and verified role alias to its original.
///
/// # Errors
/// Returns filesystem or alias verification errors.
pub fn canonical_executable(binary: &Path) -> io::Result<PathBuf> {
    canonical_identity(crate::secure_fs::canonicalize(binary)?)
}

/// Sets the full command name without exposing or changing role arguments.
pub fn name_command(command: &mut Command, role: Role) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.arg0(role.name());
    }
    #[cfg(windows)]
    let _ = (command, role);
}

/// Sets Linux's leader comm before serving requests; other platforms use the
/// executable name. Call on the main thread, not a Tokio worker.
///
/// # Errors
/// Returns the kernel's PR_SET_NAME error on Linux.
pub fn name_current() -> io::Result<()> {
    #[cfg(target_os = "linux")]
    {
        if let Some(role) = std::env::args_os()
            .next()
            .and_then(|name| ROLES.into_iter().find(|role| name == role.name()))
        {
            let name = std::ffi::CString::new(role.short_name()).map_err(io::Error::other)?;
            nix::sys::prctl::set_name(&name).map_err(io::Error::from)?;
        }
    }
    Ok(())
}

/// Name exposed by the process monitor, and the expected role name, for E2E.
/// Windows GUI monitor qualification is tracked in #260.
///
/// # Errors
/// Returns process query errors on supported hosts.
#[cfg(feature = "test-support")]
pub fn observed_name(pid: u32, role: Role) -> io::Result<Option<(String, &'static str)>> {
    #[cfg(target_os = "macos")]
    {
        let pid = i32::try_from(pid).map_err(io::Error::other)?;
        let name = libproc::proc_pid::name(pid).map_err(io::Error::other)?;
        Ok(Some((name, role.name())))
    }
    #[cfg(target_os = "linux")]
    {
        let name = fs::read_to_string(format!("/proc/{pid}/comm"))?;
        Ok(Some((name.trim().to_owned(), role.short_name())))
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = (pid, role);
        Ok(None)
    }
}

/// Writes a Unix executable fixture with the older CLI's unknown-command exit code.
///
/// # Errors
/// Returns fixture write errors; unsupported on Windows because this is a Unix fixture.
#[cfg(feature = "test-support")]
pub fn write_legacy_fixture(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        fs::write(path, "#!/bin/sh\nexit 2\n")?;
        crate::launcher::mark_executable(path).unwrap_or(Ok(()))
    }
    #[cfg(windows)]
    {
        let _ = path;
        Err(io::Error::new(io::ErrorKind::Unsupported, "Unix fixture"))
    }
}
