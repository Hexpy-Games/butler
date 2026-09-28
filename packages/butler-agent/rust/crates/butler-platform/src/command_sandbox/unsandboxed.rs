//! Hosts without a command sandbox (Linux and Windows, for now): read-only
//! commands are refused and write protection is not applied.

use std::path::Path;

use super::{Invocation, ProtectError, SandboxError};

pub(super) fn read_only(invocation: Invocation) -> Result<Invocation, SandboxError> {
    drop(invocation);
    Err(SandboxError::ReadOnlyUnavailable)
}

pub(super) fn protect_writes(
    invocation: Invocation,
    _root: &Path,
) -> Result<Invocation, ProtectError> {
    Ok(invocation)
}
