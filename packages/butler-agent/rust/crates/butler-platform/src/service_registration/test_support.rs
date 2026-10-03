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

/// Renders a Task Scheduler definition without querying or changing the host.
pub fn task_xml(definition: &Definition, sid: &str, shell: &str) -> Result<String, super::Error> {
    super::task_xml::render(definition, sid, shell)
}

/// Checks the execution fingerprint returned by a scheduler XML query.
pub fn task_owned(local: &str, queried: &str, sid: &str) -> bool {
    super::task_xml::same_owner(local, queried, sid)
}

/// Recovers the original executable and arguments from validated task XML.
pub fn task_arguments(xml: &str) -> Option<Vec<String>> {
    let task = super::task_xml::parse(xml)?;
    Some(
        std::iter::once(task.definition.program.to_string_lossy().into_owned())
            .chain(task.definition.args)
            .collect(),
    )
}

/// The enabled flag in a validated task definition.
pub fn task_enabled(xml: &str) -> Option<bool> {
    Some(super::task_xml::parse(xml)?.enabled)
}

/// Decodes a scheduler XML query without contacting the host.
pub fn task_text(bytes: &[u8]) -> Result<String, super::Error> {
    super::task_xml::decode(bytes)
}

/// Encodes the same bytes installed for schtasks, without registering a task.
pub fn task_bytes(xml: &str) -> Vec<u8> {
    super::task_xml::encode(xml)
}

/// Verifies scheduler aliases only against an independently established account.
pub fn task_owned_for_account(local: &str, remote: &str, sid: &str, account: &str) -> bool {
    super::task_xml::normalize_current_user(remote, sid, account)
        .is_some_and(|remote| super::task_xml::same_owner(local, &remote, sid))
}

/// Copies the invoking profile into a Windows task, with no manager calls.
/// Returns false on hosts whose service definitions already inherit HOME.
pub fn task_profile(definition: &mut Definition) -> bool {
    #[cfg(windows)]
    {
        super::windows::inherit_profile(definition);
        true
    }
    #[cfg(not(windows))]
    {
        let _ = definition;
        false
    }
}
