//! The canonical `butler` command: one launcher on the user's `PATH` that
//! runs whatever version `current` names.

use std::path::{Path, PathBuf};

use butler_platform::command_launcher::{self, Ownership, Removal, Target};
use butler_platform::install_link;

use super::layout::{AgentHome, BINARY, RESOURCES};
use crate::operations::update::{UpdateCode, UpdateError};

/// What syncing the launcher did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LauncherState {
    /// The launcher was written (new, or an older format of Butler's).
    Written,
    /// The launcher already ran the installed Agent.
    Current,
    /// The file at the path is not Butler's, so it was left alone.
    KeptForeign,
}

/// A launcher path and what was done to it.
#[derive(Clone, Debug)]
pub struct LauncherSync {
    /// The launcher file.
    pub path: PathBuf,
    /// What happened to it.
    pub state: LauncherState,
}

impl AgentHome {
    /// The launcher target that runs the active version. Unix follows
    /// `current`; Windows uses the version named by its pointer file.
    pub fn launcher_target(&self) -> LauncherPaths {
        let current = install_link::launcher_root(self.root(), "current")
            .unwrap_or_else(|_| self.current_path());
        LauncherPaths {
            program: current.join(BINARY),
            resources: current.join(RESOURCES),
            root: current,
        }
    }

    /// Writes the `butler` launcher at `path` (`~/.local/bin/butler` by
    /// default) when the path is free or holds a launcher of Butler's; a file
    /// that is not Butler's is left alone. The pre-native launcher is kept
    /// beside it as `butler.previous`.
    ///
    /// # Errors
    ///
    /// `install_write_failed`, and `install_home_unavailable` when there is no
    /// default path.
    pub fn sync_command_launcher(&self, path: Option<&Path>) -> Result<LauncherSync, UpdateError> {
        let path = launcher_path(path)?;
        let paths = self.launcher_target();
        let wanted = command_launcher::render(&Target {
            program: &paths.program,
            installation_root: &paths.root,
            resource_root: &paths.resources,
            data_default: None,
        });
        let failed = |error| UpdateError::caused(UpdateCode::InstallWriteFailed, error);
        let state = match command_launcher::ownership(&path).map_err(failed)? {
            Some(Ownership::Foreign) => LauncherState::KeptForeign,
            Some(Ownership::Ours) if command_launcher::is_current(&path, &wanted) => {
                LauncherState::Current
            }
            existing => {
                if existing == Some(Ownership::Stale) {
                    command_launcher::keep_previous(&path).map_err(failed)?;
                }
                command_launcher::write(&path, &wanted).map_err(failed)?;
                LauncherState::Written
            }
        };
        Ok(LauncherSync { path, state })
    }

    /// Removes the `butler` launcher at `path` (default as above) when it is
    /// Butler's.
    ///
    /// # Errors
    ///
    /// `install_write_failed`, and `install_home_unavailable` when there is
    /// no default path.
    pub fn remove_command_launcher(
        &self,
        path: Option<&Path>,
    ) -> Result<(PathBuf, Removal), UpdateError> {
        let path = launcher_path(path)?;
        let failed = |error| UpdateError::caused(UpdateCode::InstallWriteFailed, error);
        // A launcher that runs another Agent home is that home's.
        let ours = match command_launcher::ownership(&path).map_err(failed)? {
            Some(Ownership::Ours) => std::fs::read_to_string(&path)
                .ok()
                .and_then(|text| command_launcher::program(&text))
                .is_some_and(|program| self.contains(&program)),
            _ => false,
        };
        let removal = if ours {
            command_launcher::remove_if_ours(&path).map_err(failed)?
        } else if path.exists() {
            Removal::Kept
        } else {
            Removal::Absent
        };
        Ok((path, removal))
    }
}

/// Where a launcher runs the active version from.
#[derive(Clone, Debug)]
pub struct LauncherPaths {
    /// `current/butler-agent`.
    pub program: PathBuf,
    /// `current`.
    pub root: PathBuf,
    /// `current/resources`.
    pub resources: PathBuf,
}

fn launcher_path(path: Option<&Path>) -> Result<PathBuf, UpdateError> {
    path.map(Path::to_path_buf)
        .or_else(command_launcher::default_path)
        .ok_or_else(|| UpdateCode::InstallHomeUnavailable.into())
}
