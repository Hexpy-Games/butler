//! Hosts without a process identity implementation (Windows, for now).

use super::IdentityError;

pub(super) fn process_start_identity(_pid: u32) -> Result<Option<String>, IdentityError> {
    Err(IdentityError::Unsupported)
}

pub(super) fn process_executable(_pid: u32) -> Result<Option<String>, IdentityError> {
    Err(IdentityError::Unsupported)
}
