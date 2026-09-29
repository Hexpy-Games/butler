//! `launchctl` calls for the user's GUI domain.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use super::super::unix::{read_definition, remove_definition, run, run_checked, write_definition};
use super::super::{
    Activation, Definition, Error, Job, LAUNCHD_LABEL, Manager, Registration, Removal, Status,
};
use super::{arguments, render};
use crate::{instance, user_dirs};

pub(in super::super) const MANAGER: Manager = Manager::Launchd;

/// How long `restart` waits for the stopped job's process to be gone before
/// it loads the job again.
const EXIT_TIMEOUT: Duration = Duration::from_secs(40);

pub(in super::super) fn definition_path() -> Result<PathBuf, Error> {
    let home = user_dirs::home_dir()
        .filter(|home| !home.as_os_str().is_empty())
        .ok_or(Error::NoHome)?;
    Ok(home
        .join("Library")
        .join("LaunchAgents")
        .join(format!("{LAUNCHD_LABEL}.plist")))
}

pub(in super::super) fn install(
    definition: &Definition,
    activation: Activation,
) -> Result<Registration, Error> {
    let path = definition_path()?;
    if activation == Activation::FilesOnly {
        write_definition(&path, &render(definition))?;
        return Ok(registration(path, false));
    }
    // Refuse before anything is written: a job of this label that is loaded
    // from another definition is not ours to replace.
    let target = target()?;
    let loaded = loaded_from(&target);
    if let Some(elsewhere) = loaded.as_ref().filter(|loaded| !same_path(loaded, &path)) {
        return Err(Error::Foreign(elsewhere.clone()));
    }
    write_definition(&path, &render(definition))?;
    if loaded.is_some() {
        // Reload with the new definition; the old job may be gone already.
        let _ = run("launchctl", &["bootout", &target]);
    }
    bootstrap(&path)?;
    Ok(registration(path, true))
}

pub(in super::super) fn uninstall(activation: Activation) -> Result<Removal, Error> {
    let path = definition_path()?;
    let mut unloaded = false;
    if activation == Activation::Load {
        let target = target()?;
        // Another definition of the label, loaded from elsewhere, is not ours
        // to unload.
        if loaded_from(&target).is_some_and(|loaded| same_path(&loaded, &path)) {
            run_checked("launchctl", &["bootout", &target])?;
            unloaded = true;
        }
    }
    Ok(Removal {
        definition_removed: remove_definition(&path)?,
        unloaded,
    })
}

pub(in super::super) fn status() -> Result<Status, Error> {
    let path = definition_path()?;
    let registered = path.is_file();
    let printed = print(&target()?);
    Ok(Status {
        manager: MANAGER,
        definition: path,
        registered,
        loaded: Some(printed.is_some()),
        running: printed.map(|text| text.lines().any(|line| line.trim() == "state = running")),
    })
}

pub(in super::super) fn is_owned_by(directory: &Path) -> Result<bool, Error> {
    let text = read_definition(&definition_path()?)?;
    Ok(text
        .and_then(|text| arguments(&text).into_iter().next())
        .is_some_and(|program| Path::new(&program).starts_with(directory)))
}

pub(in super::super) fn job() -> Result<Job, Error> {
    let printed = print_state(&target()?);
    Ok(Job {
        loaded: matches!(printed, Printed::Loaded(_)),
        pid: match &printed {
            Printed::Loaded(text) => pid_of(text),
            _ => None,
        },
        reachable: !matches!(printed, Printed::Unknown),
    })
}

/// Runs the loaded job now; loads it first when it is not loaded.
pub(in super::super) fn start() -> Result<(), Error> {
    let target = target()?;
    if print(&target).is_some() {
        return run_checked("launchctl", &["kickstart", &target]);
    }
    let path = definition_path()?;
    if !path.is_file() {
        return Err(Error::NotRegistered);
    }
    bootstrap(&path)
}

/// Unloads the job: launchd asks the process to stop, ends it after its exit
/// timeout, and does not relaunch an unloaded job.
pub(in super::super) fn stop() -> Result<(), Error> {
    let target = target()?;
    if print(&target).is_none() {
        return Ok(());
    }
    run_checked("launchctl", &["bootout", &target])
}

/// Unloads the job, waits for its process to be gone (a new one would find
/// the old one still running) and loads the job again. It fails, without
/// loading, while the old process still runs; the process is told from a
/// reused pid by its start time. Loading is tried twice.
pub(in super::super) fn restart() -> Result<(), Error> {
    let pid = job()?.pid;
    let started = pid.and_then(|pid| instance::process_start(pid).ok().flatten());
    stop()?;
    if let (Some(pid), Some(started)) = (pid, started) {
        let deadline = Instant::now() + EXIT_TIMEOUT;
        while instance::process_start(pid).ok().flatten().as_ref() == Some(&started) {
            if Instant::now() >= deadline {
                return Err(Error::Manager {
                    command: "launchctl bootout".into(),
                    message: "the service did not exit; it was not loaded again".into(),
                });
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    start().or_else(|_| {
        std::thread::sleep(Duration::from_secs(1));
        start()
    })
}

/// launchd has no queued restart: a caller the job owns cannot survive it.
pub(in super::super) fn restart_detached() -> Result<bool, Error> {
    Ok(false)
}

fn bootstrap(path: &Path) -> Result<(), Error> {
    run_checked(
        "launchctl",
        &["bootstrap", &domain()?, &path.to_string_lossy()],
    )
}

fn registration(definition: PathBuf, loaded: bool) -> Registration {
    Registration {
        manager: MANAGER,
        definition,
        loaded,
    }
}

fn domain() -> Result<String, Error> {
    let output = run("id", &["-u"])?;
    let uid = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if !output.status.success() || uid.is_empty() {
        return Err(Error::Manager {
            command: "id -u".into(),
            message: "the user id is unavailable".into(),
        });
    }
    Ok(format!("gui/{uid}"))
}

fn target() -> Result<String, Error> {
    Ok(format!("{}/{LAUNCHD_LABEL}", domain()?))
}

/// What `launchctl print` says about the job.
enum Printed {
    Loaded(String),
    /// launchd answered that there is no such job.
    NotLoaded,
    /// launchd could not be asked (or answered something else).
    Unknown,
}

/// `launchctl` exits with this status for a service it does not know.
const NO_SUCH_SERVICE: i32 = 113;

fn print_state(target: &str) -> Printed {
    let Ok(output) = run("launchctl", &["print", target]) else {
        return Printed::Unknown;
    };
    if output.status.success() {
        Printed::Loaded(String::from_utf8_lossy(&output.stdout).into_owned())
    } else if output.status.code() == Some(NO_SUCH_SERVICE) {
        Printed::NotLoaded
    } else {
        Printed::Unknown
    }
}

/// `launchctl print` of the job; `None` unless it is loaded.
fn print(target: &str) -> Option<String> {
    match print_state(target) {
        Printed::Loaded(text) => Some(text),
        _ => None,
    }
}

/// The process of the job (`pid = N`).
fn pid_of(text: &str) -> Option<u32> {
    text.lines()
        .find_map(|line| line.trim().strip_prefix("pid = ")?.trim().parse().ok())
}

/// The plist the loaded job came from.
fn loaded_from(target: &str) -> Option<PathBuf> {
    print(target).and_then(|text| {
        text.lines().find_map(|line| {
            line.trim()
                .strip_prefix("path = ")
                .map(|path| PathBuf::from(path.trim()))
        })
    })
}

/// The same file, though one path may go through a link (`/var` is
/// `/private/var` on macOS).
fn same_path(left: &Path, right: &Path) -> bool {
    left == right
        || matches!(
            (left.canonicalize(), right.canonicalize()),
            (Ok(left), Ok(right)) if left == right
        )
}
