//! The Windows Task Scheduler port has not landed: every call says so.

use std::path::{Path, PathBuf};

use super::{Activation, Definition, Error, Manager, Registration, Removal, Status};

pub(super) const MANAGER: Manager = Manager::TaskScheduler;

pub(super) fn definition_path() -> Result<PathBuf, Error> {
    Err(Error::Unsupported)
}

pub(super) fn install(_: &Definition, _: Activation) -> Result<Registration, Error> {
    Err(Error::Unsupported)
}

pub(super) fn uninstall(_: Activation) -> Result<Removal, Error> {
    Err(Error::Unsupported)
}

pub(super) fn status() -> Result<Status, Error> {
    Err(Error::Unsupported)
}

pub(super) fn is_owned_by(_: &Path) -> Result<bool, Error> {
    Err(Error::Unsupported)
}
