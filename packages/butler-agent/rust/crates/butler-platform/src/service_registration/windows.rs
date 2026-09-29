//! The Windows Task Scheduler port has not landed: every call says so.

use std::path::{Path, PathBuf};

use super::{Activation, Definition, Error, Job, Manager, Registration, Removal, Status};

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

pub(super) fn job() -> Result<Job, Error> {
    Err(Error::Unsupported)
}

pub(super) fn start() -> Result<(), Error> {
    Err(Error::Unsupported)
}

pub(super) fn stop() -> Result<(), Error> {
    Err(Error::Unsupported)
}

pub(super) fn restart() -> Result<(), Error> {
    Err(Error::Unsupported)
}

pub(super) fn restart_detached() -> Result<bool, Error> {
    Err(Error::Unsupported)
}

pub(super) fn arguments(_: &str) -> Vec<String> {
    Vec::new()
}
