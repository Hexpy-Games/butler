//! The Agent home: `<version>-<sha8>` directories, a `current` pointer to
//! the active one and a `previous` pointer kept for rollback.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use butler_platform::{install_link, user_dirs};

use super::manifest::read_manifest;
use crate::operations::update::{UpdateCode, UpdateError};

/// The pointer to the active version directory.
pub(super) const CURRENT: &str = "current";
/// The pointer to the version directory `rollback` returns to.
pub(super) const PREVIOUS: &str = "previous";
/// The executable inside a version directory.
pub const BINARY: &str = "butler-agent";
/// The resource tree inside a version directory.
pub const RESOURCES: &str = "resources";

/// One Agent home directory and the versions installed in it.
#[derive(Clone, Debug)]
pub struct AgentHome {
    root: PathBuf,
}

/// An installed version.
#[derive(Clone, Debug)]
pub struct InstalledVersion {
    /// The directory name, `<version>-<first 8 of binarySha256>`.
    pub dir: String,
    /// The version its manifest records.
    pub version: String,
    /// The directory `current` names.
    pub active: bool,
    /// The directory `previous` names.
    pub previous: bool,
    /// When the directory was installed, in milliseconds since the epoch.
    pub installed_at_ms: u64,
}

impl AgentHome {
    /// The Agent home at `root`.
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    /// The home this user's CLI installs into (`BUTLER_AGENT_HOME`, else the
    /// per-OS default).
    ///
    /// # Errors
    ///
    /// `install_home_unavailable` without a home directory.
    pub fn resolve() -> Result<Self, UpdateError> {
        user_dirs::agent_home()
            .map(Self::new)
            .ok_or_else(|| UpdateCode::InstallHomeUnavailable.into())
    }

    /// The home's directory.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The path of an installed version's directory.
    pub fn version_path(&self, dir: &str) -> PathBuf {
        self.root.join(dir)
    }

    /// The `current` pointer, a stable path to the active version's files.
    pub fn current_path(&self) -> PathBuf {
        self.root.join(CURRENT)
    }

    /// The active version's directory name, if one is active.
    ///
    /// # Errors
    ///
    /// `install_switch_failed` when `current` exists but is not a pointer.
    pub fn active(&self) -> Result<Option<String>, UpdateError> {
        pointer(&self.root, CURRENT)
    }

    /// The rollback version's directory name, if there is one.
    ///
    /// # Errors
    ///
    /// `install_switch_failed` when `previous` exists but is not a pointer.
    pub fn previous(&self) -> Result<Option<String>, UpdateError> {
        pointer(&self.root, PREVIOUS)
    }

    /// The installed versions, newest installation first. A directory that is
    /// not a complete installation of the version its name says (no manifest,
    /// a name that does not match it) is not a version and is left out.
    ///
    /// # Errors
    ///
    /// `install_home_unavailable` when the home cannot be read.
    pub fn versions(&self) -> Result<Vec<InstalledVersion>, UpdateError> {
        let entries = match fs::read_dir(&self.root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => {
                return Err(UpdateError::caused(
                    UpdateCode::InstallHomeUnavailable,
                    error,
                ));
            }
        };
        let active = self.active()?;
        let previous = self.previous()?;
        let mut versions = Vec::new();
        for entry in entries.flatten() {
            let Some(dir) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            let Ok(metadata) = fs::symlink_metadata(entry.path()) else {
                continue;
            };
            if dir.starts_with('.') || !metadata.is_dir() {
                continue;
            }
            let Ok(manifest) = read_manifest(&entry.path()) else {
                continue;
            };
            if manifest.dir_name() != dir {
                continue;
            }
            versions.push(InstalledVersion {
                active: active.as_deref() == Some(dir.as_str()),
                previous: previous.as_deref() == Some(dir.as_str()),
                installed_at_ms: modified_ms(&metadata),
                version: manifest.version,
                dir,
            });
        }
        versions.sort_by(|left, right| {
            right
                .installed_at_ms
                .cmp(&left.installed_at_ms)
                .then_with(|| left.dir.cmp(&right.dir))
        });
        Ok(versions)
    }

    /// The installed version `selector` names: a directory name, or a version
    /// that exactly one installed directory carries.
    ///
    /// # Errors
    ///
    /// `install_version_not_found`, or `install_version_ambiguous` when
    /// several directories carry the version (name the directory then).
    pub fn find(&self, selector: &str) -> Result<InstalledVersion, UpdateError> {
        let versions = self.versions()?;
        if let Some(exact) = versions.iter().find(|version| version.dir == selector) {
            return Ok(exact.clone());
        }
        let mut matching = versions
            .into_iter()
            .filter(|version| version.version == selector);
        match (matching.next(), matching.next()) {
            (Some(only), None) => Ok(only),
            (Some(_), Some(_)) => Err(UpdateCode::InstallVersionAmbiguous.into()),
            (None, _) => Err(UpdateCode::InstallVersionNotFound.into()),
        }
    }

    /// The version a rollback returns to: the one `to` selects, else the one
    /// `previous` names.
    ///
    /// # Errors
    ///
    /// `install_nothing_to_roll_back` without `to` and without a usable
    /// `previous`; the lookup codes of [`AgentHome::find`] with `to`.
    pub fn rollback_target(&self, to: Option<&str>) -> Result<InstalledVersion, UpdateError> {
        if let Some(selector) = to {
            return self.find(selector);
        }
        // `previous` is written by the installers; without it (or with one
        // that names a removed version) the newest other version is used.
        let named = self.previous().ok().flatten();
        let versions = self.versions()?;
        named
            .and_then(|previous| versions.iter().find(|version| version.dir == previous))
            .or_else(|| versions.iter().find(|version| !version.active))
            .cloned()
            .ok_or_else(|| UpdateCode::InstallNothingToRollBack.into())
    }

    /// The manifest version of the active installation.
    pub fn active_version(&self) -> Option<String> {
        let dir = self.active().ok().flatten()?;
        read_manifest(&self.version_path(&dir))
            .ok()
            .map(|manifest| manifest.version)
    }
}

/// The directory name of a version: `<version>-<first 8 of binarySha256>`.
pub fn version_dir_name(version: &str, binary_sha256: &str) -> String {
    let short = binary_sha256.get(..8).unwrap_or(binary_sha256);
    format!("{version}-{short}")
}

fn pointer(root: &Path, link: &str) -> Result<Option<String>, UpdateError> {
    install_link::read(root, link)
        .map_err(|error| UpdateError::caused(UpdateCode::InstallSwitchFailed, error))
}

fn modified_ms(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}
