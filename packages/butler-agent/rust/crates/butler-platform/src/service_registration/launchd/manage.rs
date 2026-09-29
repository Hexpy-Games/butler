//! `launchctl` calls for the user's GUI domain.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use super::super::unix::{read_definition, remove_definition, run, run_checked, write_definition};
use super::super::{
    Activation, Definition, Error, Job, LAUNCHD_LABEL, Manager, Registration, Removal, Status,
};
use super::{program, render};
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
        .and_then(|text| program(&text))
        .is_some_and(|program| Path::new(&program).starts_with(directory)))
}

pub(in super::super) fn job() -> Result<Job, Error> {
    let printed = print(&target()?);
    Ok(Job {
        loaded: printed.is_some(),
        pid: printed.as_deref().and_then(pid_of),
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
/// the old one still running) and loads the job again.
pub(in super::super) fn restart() -> Result<(), Error> {
    let pid = job()?.pid;
    stop()?;
    if let Some(pid) = pid {
        let deadline = Instant::now() + EXIT_TIMEOUT;
        while instance::process_start(pid).ok().flatten().is_some() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    start()
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

/// `launchctl print` of the job; `None` when it is not loaded.
fn print(target: &str) -> Option<String> {
    let output = run("launchctl", &["print", target]).ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
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
