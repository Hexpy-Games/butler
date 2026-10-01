//! A private systemctl fixture; never talks to the host's user manager.
use super::{Definition, Manager};
use std::{
    io,
    path::{Path, PathBuf},
};

/// Publishes a systemd definition and a private systemctl fixture for E2Es.
pub fn systemd_fixture(root: &Path, home: &Path, definition: &Definition) -> io::Result<PathBuf> {
    let directory = home.join(".config/systemd/user");
    std::fs::create_dir_all(&directory)?;
    let unit = super::render(Manager::SystemdUser, definition).map_err(io::Error::other)?;
    std::fs::write(directory.join(super::SYSTEMD_UNIT), unit)?;
    let bin = root.join("manager-bin");
    std::fs::create_dir_all(&bin)?;
    let script = bin.join("systemctl");
    std::fs::write(
        &script,
        r#"#!/bin/sh
case "$2" in
show) printf 'LoadState=loaded\nMainPID='; cat "$BUTLER_E2E_MANAGER_ROOT/manager-pid" 2>/dev/null || echo 0 ;;
start) touch "$BUTLER_E2E_MANAGER_ROOT/manager-start" ;;
stop) touch "$BUTLER_E2E_MANAGER_ROOT/manager-stop" ;;
reset-failed|daemon-reload) exit 0 ;;
is-active) echo active ;;
is-enabled) echo enabled ;;
*) exit 1 ;;
esac
"#,
    )?;
    crate::launcher::mark_executable(&script).unwrap_or(Ok(()))?;
    Ok(bin)
}
