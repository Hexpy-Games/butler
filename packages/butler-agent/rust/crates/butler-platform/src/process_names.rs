//! Owner-facing child names without changing binary bytes or instance identity.
//!
//! macOS resolves symlinks before choosing the GUI name, so aliases are hard
//! links. Linux uses a short basename/comm and the full name in argv[0].
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
            Self::Memory => "butler(memory)",
            Self::Restart => "butler(restart)",
            Self::Update => "butler(update)",
        }
    }

    fn file_name(self) -> &'static str {
        self.short_name()
    }
}

const ROLES: [Role; 3] = [Role::Memory, Role::Restart, Role::Update];

/// Creates or verifies aliases before an installation becomes read-only.
/// Existing foreign entries are refused, never replaced. No binary is copied.
/// Windows keeps its original filename pending Task Manager integration.
///
/// # Errors
/// Returns filesystem errors or `InvalidData` for a foreign alias.
// TODO(#260): Windows Task Manager needs per-role image names plus stable file
// identity and Processes-tab verification; argv[0]/thread descriptions do not suffice.
pub fn prepare(binary: &Path) -> io::Result<()> {
    if cfg!(windows) {
        return Ok(());
    }
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

/// The verified alias to execute, or the original binary in older layouts.
/// Missing aliases preserve compatibility; a foreign alias fails closed.
///
/// # Errors
/// Returns filesystem errors or `InvalidData` for a foreign alias.
pub fn executable(binary: &Path, role: Role) -> io::Result<PathBuf> {
    let binary = canonical_executable(binary)?;
    if cfg!(windows) {
        return Ok(binary);
    }
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
    if !metadata.is_file() || !crate::secure_fs::same_file(&fs::metadata(binary)?, &metadata) {
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
    if cfg!(windows)
        || !ROLES.iter().any(|role| {
            path.file_name()
                .is_some_and(|name| name == role.file_name())
        })
    {
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
/// Windows monitor qualification is tracked in #260.
///
/// # Errors
/// Returns process query errors on supported hosts.
#[cfg(feature = "test-support")]
pub fn observed_name(pid: u32, role: Role) -> io::Result<Option<(String, &'static str)>> {
    #[cfg(target_os = "macos")]
    {
        let pid = i32::try_from(pid).map_err(io::Error::other)?;
        let name = libproc::proc_pid::name(pid).map_err(io::Error::other)?;
        Ok(Some((name, role.short_name())))
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
