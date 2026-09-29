//! `systemctl --user` calls.

use std::path::{Path, PathBuf};

use super::super::unix::{read_definition, remove_definition, run, run_checked, write_definition};
use super::super::{
    Activation, Definition, Error, Job, Manager, Registration, Removal, SYSTEMD_UNIT, Status,
};
use super::{program, render};
use crate::user_dirs;

pub(in super::super) const MANAGER: Manager = Manager::SystemdUser;

/// `${XDG_CONFIG_HOME:-~/.config}/systemd/user/butler-agent.service`.
pub(in super::super) fn definition_path() -> Result<PathBuf, Error> {
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(|| {
            user_dirs::home_dir()
                .filter(|home| !home.as_os_str().is_empty())
                .map(|home| home.join(".config"))
        })
        .ok_or(Error::NoHome)?;
    Ok(config.join("systemd").join("user").join(SYSTEMD_UNIT))
}

pub(in super::super) fn install(
    definition: &Definition,
    activation: Activation,
) -> Result<Registration, Error> {
    let path = definition_path()?;
    write_definition(&path, &render(definition))?;
    if activation == Activation::Load {
        run_checked("systemctl", &["--user", "daemon-reload"])?;
        // A spent crash budget is cleared by an explicit install; the unit
        // may not be loaded yet.
        let _ = run("systemctl", &["--user", "reset-failed", SYSTEMD_UNIT]);
        run_checked("systemctl", &["--user", "enable", "--now", SYSTEMD_UNIT])?;
    }
    Ok(Registration {
        manager: MANAGER,
        definition: path,
        loaded: activation == Activation::Load,
    })
}

pub(in super::super) fn uninstall(activation: Activation) -> Result<Removal, Error> {
    let path = definition_path()?;
    let mut unloaded = false;
    if activation == Activation::Load && path.is_file() {
        unloaded = run("systemctl", &["--user", "disable", "--now", SYSTEMD_UNIT])
            .is_ok_and(|output| output.status.success());
    }
    let definition_removed = remove_definition(&path)?;
    if activation == Activation::Load && definition_removed {
        let _ = run("systemctl", &["--user", "daemon-reload"]);
    }
    Ok(Removal {
        definition_removed,
        unloaded,
    })
}

pub(in super::super) fn status() -> Result<Status, Error> {
    let path = definition_path()?;
    let registered = path.is_file();
    Ok(Status {
        manager: MANAGER,
        definition: path,
        registered,
        loaded: answer("is-enabled").map(|state| state == "enabled"),
        running: answer("is-active").map(|state| state == "active"),
    })
}

pub(in super::super) fn is_owned_by(directory: &Path) -> Result<bool, Error> {
    let text = read_definition(&definition_path()?)?;
    Ok(text
        .and_then(|text| program(&text))
        .is_some_and(|program| Path::new(&program).starts_with(directory)))
}

/// The unit is loaded when `systemctl show` knows it; its `MainPID` is the
/// process it runs (0 when none).
pub(in super::super) fn job() -> Result<Job, Error> {
    let Ok(output) = run(
        "systemctl",
        &[
            "--user",
            "show",
            "--property=LoadState,MainPID",
            SYSTEMD_UNIT,
        ],
    ) else {
        return Ok(Job::default());
    };
    if !output.status.success() {
        return Ok(Job::default());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let property = |name: &str| {
        text.lines()
            .find_map(|line| line.strip_prefix(name)?.strip_prefix('='))
    };
    Ok(Job {
        loaded: property("LoadState") == Some("loaded"),
        pid: property("MainPID")
            .and_then(|pid| pid.trim().parse().ok())
            .filter(|pid| *pid != 0),
    })
}

pub(in super::super) fn start() -> Result<(), Error> {
    run_checked("systemctl", &["--user", "start", SYSTEMD_UNIT])
}

pub(in super::super) fn stop() -> Result<(), Error> {
    run_checked("systemctl", &["--user", "stop", SYSTEMD_UNIT])
}

pub(in super::super) fn restart() -> Result<(), Error> {
    run_checked("systemctl", &["--user", "restart", SYSTEMD_UNIT])
}

/// The one-word answer of `systemctl --user <verb> butler-agent.service`
/// (`enabled`, `active`, ...); `None` when the user manager cannot be
/// reached.
fn answer(verb: &str) -> Option<String> {
    let output = run("systemctl", &["--user", verb, SYSTEMD_UNIT]).ok()?;
    let word = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if word.is_empty() || word.contains("Failed to connect") {
        return None;
    }
    Some(word)
}
