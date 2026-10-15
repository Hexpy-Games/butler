//! Opt-in Windows project writes; observations keep exact-action approval.
mod drive;
pub(crate) mod launch;
pub(in crate::command_sandbox) mod prepare;
mod probe;
mod sdk;
use super::super::{Invocation, ProtectError, Protection, SandboxCapabilities, SandboxError};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};
pub(super) type Error = Box<dyn std::error::Error>;
pub(in crate::command_sandbox) use drive::reconcile;
pub(in crate::command_sandbox) use probe::probe;

pub(super) fn helper() -> std::io::Result<PathBuf> {
    #[cfg(feature = "test-support")]
    if let Some(path) = std::env::var_os("NEXTEST_BIN_EXE_butler-sandbox")
        .or_else(|| std::env::var_os("NEXTEST_BIN_EXE_butler_sandbox"))
    {
        return Ok(path.into());
    }
    let exe = std::env::current_exe()?;
    let parent = exe
        .parent()
        .ok_or_else(|| std::io::Error::other("helper_missing"))?;
    #[cfg(feature = "test-support")]
    let parent = if parent.file_name().is_some_and(|s| s == "deps") {
        parent
            .parent()
            .ok_or_else(|| std::io::Error::other("helper_missing"))?
    } else {
        parent
    };
    Ok(parent.join("butler-sandbox.exe"))
}
pub(in crate::command_sandbox) fn read_only_contained(
    _invocation: Invocation,
    _environment: &HashMap<String, String>,
    _denied: &[&Path],
    _allowed: &[&Path],
) -> Result<Invocation, SandboxError> {
    Err(SandboxError::ReadOnlyUnavailable)
}
pub(in crate::command_sandbox) fn protect_writes(
    invocation: Invocation,
    _root: &Path,
) -> Result<Protection, ProtectError> {
    Ok(Protection::Unavailable(invocation))
}
pub(in crate::command_sandbox) fn project_write(
    invocation: Invocation,
    environment: &HashMap<String, String>,
    root: &Path,
    writable: &[&Path],
    denied: &[&Path],
) -> Result<Invocation, SandboxError> {
    if !super::super::project_write_available() {
        return Err(SandboxError::ProjectWriteUnavailable);
    }
    prepare::invocation(invocation, environment, root, writable, denied)
}

#[cfg(feature = "test-support")]
pub(in crate::command_sandbox) fn verify_recovery_contract() {
    drive::verify_inaccessible_process();
    launch::verify_cleanup_status();
}
