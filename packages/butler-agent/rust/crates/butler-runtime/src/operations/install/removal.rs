//! Removing an Agent home for `butler uninstall`.
//!
//! Only what the installer put there goes: version directories, the two
//! pointers, leftover staging directories and the lock file. Anything else
//! in the directory is the user's, stays, and keeps the directory itself in
//! place. Nothing is removed through a symbolic link.

use std::fs;
use std::time::Duration;

use butler_platform::install_link;

use super::layout::{CURRENT, PREVIOUS};
use super::transaction::{HomeLock, remove_tree};
use crate::operations::update::{UpdateCode, UpdateError};

const LOCK_FILE: &str = ".install.lock";

/// What removing a home did.
#[derive(Clone, Debug, Default)]
pub struct HomeRemoval {
    /// Version directories that were removed.
    pub removed: Vec<String>,
    /// Entries that are not the installer's and stay.
    pub kept: Vec<String>,
    /// The home directory itself is gone.
    pub home_removed: bool,
}

impl HomeLock {
    /// Removes every installed version, the pointers and the lock file.
    ///
    /// # Errors
    ///
    /// `install_write_failed` when an installed directory cannot be removed;
    /// `install_switch_failed` when a pointer cannot be removed.
    pub fn remove_all(self) -> Result<HomeRemoval, UpdateError> {
        let home = self.home().clone();
        let mut outcome = HomeRemoval::default();
        for version in home.versions()? {
            remove_tree(&home.version_path(&version.dir))?;
            outcome.removed.push(version.dir);
        }
        for link in [CURRENT, PREVIOUS] {
            install_link::remove(home.root(), link)
                .map_err(|error| UpdateError::caused(UpdateCode::InstallSwitchFailed, error))?;
        }
        self.remove_staging(Duration::ZERO)?;
        drop(self);
        let _ = fs::remove_file(home.root().join(LOCK_FILE));
        if let Ok(entries) = fs::read_dir(home.root()) {
            outcome.kept = entries
                .flatten()
                .filter_map(|entry| entry.file_name().to_str().map(str::to_owned))
                .collect();
            outcome.kept.sort();
        }
        outcome.home_removed = fs::remove_dir(home.root()).is_ok();
        Ok(outcome)
    }
}
