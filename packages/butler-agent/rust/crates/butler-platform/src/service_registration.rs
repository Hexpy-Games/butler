//! Login-time start of the Agent service: a launchd LaunchAgent on macOS, a
//! systemd `--user` unit on Linux, and a Task Scheduler task on
//! Windows.
//!
//! The definition restarts the service after a crash only. An intentional
//! stop (`butler stop`, SIGTERM from a supervisor) makes the service exit 0,
//! which none of these managers restarts, so a stopped service stays
//! stopped until the next login or an explicit start.
//!
//! [`Activation::FilesOnly`] writes and removes the definition without
//! asking the manager to load, enable or unload anything.
//!
//! The service manager is per user, not per `HOME`: a launchd job or a systemd
//! user unit of this label is the same one whatever `HOME` a process has, so a
//! sandboxed `HOME` does not isolate anything. `BUTLER_SERVICE_MANAGER=off`
//! switches every manager request off (the job then reads as not loaded and
//! only the definition file is written), and tests set it unless they mean to
//! use the real manager. The labels differ from the ones the Butler App's
//! legacy migration removes (`com.hexpy.butler`, `butler.service`).

use std::io;
use std::path::{Path, PathBuf};

#[cfg(feature = "test-support")]
pub mod test_support;

#[cfg(unix)]
mod launchd;
#[cfg(unix)]
mod systemd;
#[cfg(unix)]
mod unix;
#[cfg(unix)]
use unix as sys;
#[cfg(any(windows, feature = "test-support"))]
#[path = "service_registration/windows/xml.rs"]
mod task_xml;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as sys;

/// The launchd label of the CLI-registered service.
pub const LAUNCHD_LABEL: &str = "com.hexpy.butler.agent";
/// The systemd user unit of the CLI-registered service.
pub const SYSTEMD_UNIT: &str = "butler-agent.service";
/// The variable that switches manager requests off (`off`).
pub const MANAGER_VARIABLE: &str = "BUTLER_SERVICE_MANAGER";
/// How long the manager waits for the service to exit after asking it to,
/// before it kills it.
#[cfg_attr(not(unix), allow(dead_code))]
const STOP_GRACE_SECONDS: u32 = 20;

/// Whether manager requests are switched off (see [`MANAGER_VARIABLE`]).
pub fn manager_disabled() -> bool {
    std::env::var(MANAGER_VARIABLE).is_ok_and(|value| value.trim() == "off")
}

/// The service manager of this host.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Manager {
    /// macOS launchd (a LaunchAgent in the user's domain).
    Launchd,
    /// systemd's per-user instance.
    SystemdUser,
    /// The Windows Task Scheduler.
    TaskScheduler,
}

impl Manager {
    /// The manager's name in output and JSON.
    pub fn name(self) -> &'static str {
        match self {
            Self::Launchd => "launchd",
            Self::SystemdUser => "systemd-user",
            Self::TaskScheduler => "task-scheduler",
        }
    }
}

/// What the manager starts at login.
#[derive(Clone, Debug)]
pub struct Definition {
    /// The Agent executable.
    pub program: PathBuf,
    /// Its arguments.
    pub args: Vec<String>,
    /// The service's working directory (the data folder).
    pub working_dir: PathBuf,
    /// Environment variables of the service.
    pub env: Vec<(String, String)>,
}

/// Whether the manager is asked to act on a definition.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Activation {
    /// Load or enable it, and start it now.
    Load,
    /// Only write or remove the definition file.
    FilesOnly,
}

/// A registered service.
#[derive(Clone, Debug)]
pub struct Registration {
    /// The manager that owns the definition.
    pub manager: Manager,
    /// The definition file.
    pub definition: PathBuf,
    /// Whether the manager loaded it.
    pub loaded: bool,
}

/// What [`uninstall`] did.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Removal {
    /// The definition file was removed.
    pub definition_removed: bool,
    /// The manager unloaded the service.
    pub unloaded: bool,
}

/// The registration as the host sees it.
#[derive(Clone, Debug)]
pub struct Status {
    /// The manager of this host.
    pub manager: Manager,
    /// The definition file.
    pub definition: PathBuf,
    /// Whether the definition file exists.
    pub registered: bool,
    /// Whether the manager has it loaded or enabled; `None` when the manager
    /// cannot be asked (no `systemctl`, a headless session).
    pub loaded: Option<bool>,
    /// Whether the manager reports the service running; `None` as above.
    pub running: Option<bool>,
}

/// What the manager says about the registered job.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Job {
    /// The manager has the job loaded (it starts and supervises it).
    pub loaded: bool,
    /// The process the manager runs for the job now.
    pub pid: Option<u32>,
    /// The manager answered. When it did not (no `systemctl`, a session
    /// without a user manager), `loaded == false` means nothing.
    pub reachable: bool,
}

/// A definition on disk: what it runs and for which data folder.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Registered {
    /// The program the job runs.
    pub program: PathBuf,
    /// Its `--data` argument, when it has one.
    pub data: Option<PathBuf>,
}

/// Why a registration call failed.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// This host has no supported service manager yet.
    #[error("{}", unsupported_message())]
    Unsupported,
    /// The user's home directory is unknown.
    #[error("the home directory is unavailable")]
    NoHome,
    /// Reading or writing the definition failed.
    #[error(transparent)]
    Io(#[from] io::Error),
    /// The manager refused a request.
    #[error("{command}: {message}")]
    Manager {
        /// The command that failed.
        command: String,
        /// What it reported.
        message: String,
    },
    /// There is no definition to load.
    #[error("the service is not registered")]
    NotRegistered,
    /// Manager requests are switched off (see [`MANAGER_VARIABLE`]).
    #[error("service manager requests are switched off")]
    Disabled,
    /// A value cannot be written into a definition safely (a line break).
    #[error("a service definition value contains a line break")]
    InvalidValue,
    /// Another definition of the same label is loaded from elsewhere, so it
    /// is not ours to replace.
    #[error("the service is already loaded from {0}")]
    Foreign(PathBuf),
}

/// The definition file text `manager` would use for `definition`.
#[cfg_attr(not(unix), allow(unused_variables))]
pub fn render(manager: Manager, definition: &Definition) -> Result<String, Error> {
    validate(definition)?;
    match manager {
        #[cfg(unix)]
        Manager::Launchd => Ok(launchd::render(definition)),
        #[cfg(unix)]
        Manager::SystemdUser => Ok(systemd::render(definition)),
        #[cfg(not(unix))]
        Manager::Launchd | Manager::SystemdUser => Err(Error::Unsupported),
        #[cfg(windows)]
        Manager::TaskScheduler => windows::render(definition),
        #[cfg(not(windows))]
        Manager::TaskScheduler => Err(Error::Unsupported),
    }
}

/// The manager of this host.
pub fn manager() -> Manager {
    sys::MANAGER
}

/// The file the definition lives in.
///
/// # Errors
///
/// [`Error::NoHome`] without a home directory, [`Error::Unsupported`] on
/// hosts without a manager.
pub fn definition_path() -> Result<PathBuf, Error> {
    sys::definition_path()
}

/// Writes the definition and, with [`Activation::Load`], loads it and starts
/// the service.
///
/// # Errors
///
/// The failure to write the file, or the manager's refusal.
pub fn install(definition: &Definition, activation: Activation) -> Result<Registration, Error> {
    validate(definition)?;
    crate::secure_fs::create_private_dir_all(&definition.working_dir.join("logs"))?;
    sys::install(definition, activation_allowed(activation))
}

/// The activation a request gets: none while manager requests are off.
fn activation_allowed(activation: Activation) -> Activation {
    if manager_disabled() {
        Activation::FilesOnly
    } else {
        activation
    }
}

/// The definition on disk, if there is one: its program and `--data`. Reads
/// the file on Unix; on Windows verifies the scheduler XML against it.
///
/// # Errors
///
/// The failure to read the file.
pub fn registered() -> Result<Option<Registered>, Error> {
    #[cfg(windows)]
    let Some(text) = sys::registered_text()? else {
        return Ok(None);
    };
    #[cfg(not(windows))]
    let text = match std::fs::read_to_string(definition_path()?) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let words = sys::arguments(&text);
    let Some(program) = words.first() else {
        return Ok(None);
    };
    let data = words
        .iter()
        .position(|word| word == "--data")
        .and_then(|index| words.get(index + 1));
    Ok(Some(Registered {
        program: PathBuf::from(program),
        data: data.map(PathBuf::from),
    }))
}

/// What the manager says about the job: whether it is loaded and which
/// process it runs. Read-only.
///
/// # Errors
///
/// [`Error::Unsupported`] on hosts without a manager; a manager that cannot
/// be asked reports an unloaded job.
pub fn job() -> Result<Job, Error> {
    if manager_disabled() {
        return Ok(Job {
            reachable: true,
            ..Job::default()
        });
    }
    sys::job()
}

/// Starts the loaded job (loading it first where the manager unloads a
/// stopped job).
///
/// # Errors
///
/// [`Error::NotRegistered`] without a definition, or the manager's refusal.
pub fn start() -> Result<(), Error> {
    require_enabled()?;
    sys::start()
}

fn require_enabled() -> Result<(), Error> {
    if manager_disabled() {
        Err(Error::Disabled)
    } else {
        Ok(())
    }
}

/// Stops the job through the manager, which then does not relaunch it: the
/// way to end a service that ignores a polite stop, since a signal sent
/// straight to the process looks like a crash to the manager.
///
/// # Errors
///
/// The manager's refusal.
pub fn stop() -> Result<(), Error> {
    require_enabled()?;
    sys::stop()
}

/// Stops and starts the job with one request to the manager, which also
/// works for a caller the manager stops together with the job.
///
/// # Errors
///
/// The manager's refusal.
pub fn restart() -> Result<(), Error> {
    require_enabled()?;
    sys::restart()
}

/// Asks the manager to restart the job and returns without waiting, so that a
/// caller the manager stops together with the job (systemd stops everything in
/// the unit) has still made the request. `Ok(false)` when this manager cannot
/// queue a restart: the caller must then run [`restart`] from a process the
/// job does not own.
///
/// # Errors
///
/// The manager's refusal.
pub fn restart_detached() -> Result<bool, Error> {
    require_enabled()?;
    sys::restart_detached()
}

/// Every value of a definition is a single line.
fn validate(definition: &Definition) -> Result<(), Error> {
    let values = std::iter::once(definition.program.to_string_lossy().into_owned())
        .chain(definition.args.iter().cloned())
        .chain(std::iter::once(
            definition.working_dir.to_string_lossy().into_owned(),
        ))
        .chain(
            definition
                .env
                .iter()
                .flat_map(|(key, value)| [key.clone(), value.clone()]),
        );
    if values
        .into_iter()
        .any(|value| value.contains(['\n', '\r', '\0']))
    {
        return Err(Error::InvalidValue);
    }
    Ok(())
}

/// Unloads the service (with [`Activation::Load`]) and removes the
/// definition file. A registration that is not there is not an error.
///
/// # Errors
///
/// The failure to remove the file, or the manager's refusal.
pub fn uninstall(activation: Activation) -> Result<Removal, Error> {
    sys::uninstall(activation_allowed(activation))
}

/// What the file system and the manager say about the registration.
///
/// # Errors
///
/// [`Error::NoHome`] or [`Error::Unsupported`]; a manager that cannot be
/// asked is reported in the status, not as an error.
pub fn status() -> Result<Status, Error> {
    if manager_disabled() {
        return Ok(Status {
            manager: manager(),
            registered: definition_path()?.is_file(),
            definition: definition_path()?,
            loaded: None,
            running: None,
        });
    }
    sys::status()
}

/// Whether the registered definition runs a program inside `directory`, so
/// a caller can tell its own registration from the Butler App's.
///
/// # Errors
///
/// The failure to read the definition; a missing one is not owned.
pub fn is_owned_by(directory: &Path) -> Result<bool, Error> {
    sys::is_owned_by(directory)
}

fn unsupported_message() -> &'static str {
    match sys::MANAGER {
        Manager::TaskScheduler => "service registration is unavailable",
        _ => "service registration is not supported on this platform yet",
    }
}
