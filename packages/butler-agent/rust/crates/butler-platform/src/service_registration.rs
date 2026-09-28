//! The per-user service definition that starts the agent at login.
//!
//! Each host registers the agent for the current, interactive user without
//! administrator rights: a launchd agent on macOS, a `systemd --user` unit on
//! Linux and a Task Scheduler logon task on Windows (not a Windows Service,
//! which runs in session 0 without the user's registry or credentials). The
//! supervisor restarts the agent only after a failure, never after a
//! requested stop (launchd `KeepAlive { SuccessfulExit = false }`, systemd
//! `Restart=on-failure`).
//!
//! This is the interface only: the app still writes the definitions until
//! `butler service install` moves them into Rust, and until then every
//! operation reports [`RegistrationError::Unsupported`].

use std::io;
use std::path::PathBuf;

/// The per-user service manager of a host.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Supervisor {
    /// macOS launchd user agent.
    Launchd,
    /// Linux `systemd --user` unit.
    SystemdUser,
    /// Windows Task Scheduler task that runs at logon.
    TaskScheduler,
}

/// This host's service manager.
pub const SUPERVISOR: Supervisor = if cfg!(target_os = "macos") {
    Supervisor::Launchd
} else if cfg!(windows) {
    Supervisor::TaskScheduler
} else {
    Supervisor::SystemdUser
};

/// When the supervisor starts the agent again after it exited.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RestartPolicy {
    /// Only after the agent failed; a requested stop stays stopped.
    OnFailure,
}

/// What to register.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServiceDefinition {
    /// The unique name of the registration (launchd label, unit or task name).
    pub label: String,
    /// The agent executable.
    pub program: PathBuf,
    /// Its arguments, in order.
    pub arguments: Vec<String>,
    /// Environment variables set for the agent.
    pub environment: Vec<(String, String)>,
    /// When the agent is started again.
    pub restart: RestartPolicy,
}

/// Whether a registration exists and runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RegistrationState {
    /// No registration with this label exists.
    NotInstalled,
    /// Registered but not running.
    Installed,
    /// Registered and running.
    Running,
}

/// Why a registration operation failed.
#[derive(Debug, thiserror::Error)]
pub enum RegistrationError {
    /// This build cannot manage the host's service definitions yet.
    #[error("service registration through {0:?} is not implemented")]
    Unsupported(Supervisor),
    /// Writing or querying the definition failed.
    #[error(transparent)]
    Io(io::Error),
}

/// Registers `definition` with [`SUPERVISOR`], replacing a registration with
/// the same label.
pub fn install(definition: &ServiceDefinition) -> Result<(), RegistrationError> {
    let _ = definition;
    Err(RegistrationError::Unsupported(SUPERVISOR))
}

/// Removes the registration named `label`; a missing one is removed already.
pub fn uninstall(label: &str) -> Result<(), RegistrationError> {
    let _ = label;
    Err(RegistrationError::Unsupported(SUPERVISOR))
}

/// The state of the registration named `label`.
pub fn state(label: &str) -> Result<RegistrationState, RegistrationError> {
    let _ = label;
    Err(RegistrationError::Unsupported(SUPERVISOR))
}
