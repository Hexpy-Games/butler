//! `launchctl` calls for the user's GUI domain.

use std::path::{Path, PathBuf};

use super::super::unix::{read_definition, remove_definition, run, run_checked, write_definition};
use super::super::{
    Activation, Definition, Error, LAUNCHD_LABEL, Manager, Registration, Removal, Status,
};
use super::{render, xml};
use crate::user_dirs;

pub(in super::super) const MANAGER: Manager = Manager::Launchd;

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
    write_definition(&path, &render(definition))?;
    if activation == Activation::FilesOnly {
        return Ok(registration(path, false));
    }
    let target = target()?;
    match loaded_from(&target)? {
        Some(loaded) if loaded != path => return Err(Error::Foreign(loaded)),
        Some(_) => {
            // Reload with the new definition; the old job may be gone already.
            let _ = run("launchctl", &["bootout", &target]);
        }
        None => {}
    }
    let domain = domain()?;
    run_checked(
        "launchctl",
        &["bootstrap", &domain, &path.to_string_lossy()],
    )?;
    Ok(registration(path, true))
}

pub(in super::super) fn uninstall(activation: Activation) -> Result<Removal, Error> {
    let path = definition_path()?;
    let mut unloaded = false;
    if activation == Activation::Load {
        let target = target()?;
        // Another definition of the label, loaded from elsewhere, is not ours
        // to unload.
        if loaded_from(&target)?.is_some_and(|loaded| loaded == path) {
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
    let escaped = xml(&directory.to_string_lossy());
    Ok(text.is_some_and(|text| text.contains(&format!("<string>{escaped}"))))
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

/// The plist the loaded job came from.
fn loaded_from(target: &str) -> Result<Option<PathBuf>, Error> {
    Ok(print(target).and_then(|text| {
        text.lines().find_map(|line| {
            line.trim()
                .strip_prefix("path = ")
                .map(|path| PathBuf::from(path.trim()))
        })
    }))
}
