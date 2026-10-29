//! OS fixtures for Linux sandbox E2Es, kept inside the platform boundary.
use std::{io, path::Path};

/// Exercises filesystem admission without launching a container or requiring WinSta0.
/// The caller owns the isolated profile and must check capabilities before launch.
pub fn windows_prepare_project_write(
    command: &str,
    environment: &std::collections::HashMap<String, String>,
    root: &Path,
    writable: &[&Path],
    denied: &[&Path],
    toolchain_roots: Option<&super::ToolchainRoots>,
) -> Result<super::Invocation, super::SandboxError> {
    #[cfg(windows)]
    {
        super::windows::mxc::prepare::invocation(
            super::windows::login_shell(command, environment),
            environment,
            root,
            writable,
            denied,
            toolchain_roots,
        )
    }
    #[cfg(not(windows))]
    {
        let _ = (
            command,
            environment,
            root,
            writable,
            denied,
            toolchain_roots,
        );
        Err(super::SandboxError::ProjectWriteUnavailable)
    }
}

/// Exercises native/x32 syscall encodings from inside a sandboxed child.
/// Kept in the platform fixture boundary because syscall tables are OS-specific.
pub fn linux_syscall_probe(
    environment: &std::collections::HashMap<String, String>,
    allowed: &[&Path],
) -> Result<super::Invocation, super::SandboxError> {
    super::sandbox::read_only_contained(
        super::Invocation {
            program: "python3".into(),
            arguments: vec![
                "-c".into(),
                include_str!("test_support/linux_probe.py").into(),
            ],
            ..Default::default()
        },
        environment,
        &[],
        allowed,
    )
}

/// Whether this host supports the Linux-specific E2E scenarios.
pub fn linux_test_host() -> bool {
    cfg!(target_os = "linux")
}

/// Whether this Linux test host runs under Windows Subsystem for Linux.
pub fn wsl_test_host() -> bool {
    linux_test_host()
        && (Path::new("/proc/sys/fs/binfmt_misc/WSLInterop").exists()
            || std::env::var_os("WSL_DISTRO_NAME").is_some()
            || std::fs::read_to_string("/proc/sys/kernel/osrelease")
                .is_ok_and(|release| release.to_ascii_lowercase().contains("microsoft")))
}

/// A nonblocking pathname unix socket used to detect sandbox escapes.
#[derive(Debug)]
pub struct UnixSocketProbe {
    #[cfg(target_os = "linux")]
    listener: std::os::unix::net::UnixListener,
}

impl UnixSocketProbe {
    /// Binds a fixture socket; its caller owns the pathname and its cleanup.
    pub fn bind(path: &Path) -> io::Result<Self> {
        #[cfg(target_os = "linux")]
        {
            let listener = std::os::unix::net::UnixListener::bind(path)?;
            listener.set_nonblocking(true)?;
            Ok(Self { listener })
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = path;
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "Linux socket fixture",
            ))
        }
    }

    /// Accepts and drops a pending connection, or returns WouldBlock.
    pub fn accept(&self) -> io::Result<()> {
        #[cfg(target_os = "linux")]
        {
            self.listener.accept().map(|_| ())
        }
        #[cfg(not(target_os = "linux"))]
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Linux socket fixture",
        ))
    }
}

/// Exercises native recovery error classifications without elevated processes.
pub fn windows_recovery_contract() {
    #[cfg(windows)]
    super::windows::mxc::verify_recovery_contract();
}

/// Executes contained shell file transport with native PowerShell, without MXC.
pub fn windows_shell_file_contract() {
    #[cfg(windows)]
    {
        let result = super::windows::mxc::verify_shell();
        assert!(result.is_ok(), "{result:?}");
    }
}

pub(super) mod ledger;

pub(super) mod installation;
