//! Hosts without a command sandbox (Linux and Windows, for now): read-only
//! commands are refused and write protection is unavailable.

use std::path::Path;

use super::{Invocation, ProtectError, Protection, SandboxError};

pub(super) const ENFORCED: bool = false;

pub(super) fn read_only(invocation: Invocation) -> Result<Invocation, SandboxError> {
    drop(invocation);
    Err(SandboxError::ReadOnlyUnavailable)
}

pub(super) fn protect_writes(
    invocation: Invocation,
    _root: &Path,
) -> Result<Protection, ProtectError> {
    Ok(Protection::Unavailable(invocation))
}

pub(super) fn read_only_contained(
    invocation: Invocation,
    _denied: &[&Path],
    _allowed: &[&Path],
) -> Result<Invocation, SandboxError> {
    read_only(invocation)
}
