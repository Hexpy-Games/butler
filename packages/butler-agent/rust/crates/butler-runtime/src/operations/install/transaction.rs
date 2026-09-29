//! Changes to an Agent home, all made while holding its lock: installing an
//! archive as a version directory, switching `current`, rolling back and
//! pruning old versions.

use butler_platform::secure_fs::Canonical;
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use butler_platform::instance::{InstanceLock, LockError};
use butler_platform::{install_link, secure_fs};

use super::archive::extract;
use super::digest::sha256_file;
use super::layout::{AgentHome, CURRENT, PREVIOUS};
use super::manifest::verify_installation;
use crate::operations::update::{UpdateCode, UpdateError};

const LOCK_FILE: &str = ".install.lock";
const STAGING_PREFIX: &str = ".staging-";
/// How long a staging directory must sit untouched before pruning removes it.
const STALE_STAGING: Duration = Duration::from_secs(600);

/// The exclusive right to change an [`AgentHome`]. A second `butler update`
/// or `install` finds the home busy instead of racing the first.
#[derive(Debug)]
pub struct HomeLock {
    home: AgentHome,
    _lock: InstanceLock,
}

/// A version directory now in the home.
#[derive(Clone, Debug)]
pub struct Installed {
    /// The directory name, `<version>-<sha8>`.
    pub dir: String,
    /// Its manifest version.
    pub version: String,
    /// The directory.
    pub path: PathBuf,
    /// The same version was installed already and is reused.
    pub already_installed: bool,
}

/// What switching `current` did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Switched {
    /// The directory `current` names now.
    pub active: String,
    /// The directory `previous` names now.
    pub previous: Option<String>,
    /// The directory `current` named before, if any.
    pub replaced: Option<String>,
    /// `current` was switched (it named another directory before).
    pub changed: bool,
}

/// An archive installed, activated and pruned in one locked step.
#[derive(Clone, Debug)]
pub struct Activated {
    /// The version directory now in the home.
    pub installed: Installed,
    /// What switching `current` did.
    pub switched: Switched,
    /// Version directories pruned afterwards.
    pub pruned: Vec<String>,
}

impl Activated {
    /// The result as the CLI reports it.
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "dir": self.installed.dir,
            "version": self.installed.version,
            "path": self.installed.path,
            "alreadyInstalled": self.installed.already_installed,
            "previous": self.switched.previous,
            "replaced": self.switched.replaced,
            "changed": self.switched.changed,
            "pruned": self.pruned,
        })
    }
}

impl AgentHome {
    /// Installs `archive` (checking `expected_sha256` first, when given),
    /// makes it the active version and prunes old versions down to `keep`,
    /// all while holding the home's lock.
    ///
    /// # Errors
    ///
    /// The codes of [`HomeLock::install_archive`], [`HomeLock::activate`] and
    /// [`HomeLock::prune`], and `install_busy`.
    pub fn install_and_activate(
        &self,
        archive: &Path,
        expected_sha256: Option<&str>,
        keep: usize,
        protected: &[PathBuf],
    ) -> Result<Activated, UpdateError> {
        let lock = self.lock()?;
        let installed = lock.install_archive(archive, expected_sha256)?;
        let switched = lock.activate(&installed.dir)?;
        let pruned = lock.prune(keep, protected)?;
        Ok(Activated {
            installed,
            switched,
            pruned,
        })
    }

    /// Takes the home's lock, creating the home when it is missing.
    ///
    /// # Errors
    ///
    /// `install_busy` when another process holds it, `install_home_unavailable`
    /// when the home or its lock file cannot be created.
    pub fn lock(&self) -> Result<HomeLock, UpdateError> {
        let unavailable = |error| UpdateError::caused(UpdateCode::InstallHomeUnavailable, error);
        fs::create_dir_all(self.root()).map_err(unavailable)?;
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(self.root().join(LOCK_FILE))
            .map_err(unavailable)?;
        match InstanceLock::try_exclusive(file) {
            Ok(lock) => Ok(HomeLock {
                home: self.clone(),
                _lock: lock,
            }),
            Err(LockError::Busy) => Err(UpdateCode::InstallBusy.into()),
            Err(LockError::Failed(error)) => Err(unavailable(error)),
        }
    }
}

impl HomeLock {
    /// The locked home.
    pub fn home(&self) -> &AgentHome {
        &self.home
    }

    /// Verifies `archive` against `expected_sha256` (when given), extracts it
    /// beside the versions, verifies what came out against its own manifest
    /// and moves it into `<version>-<sha8>`. Nothing is switched.
    ///
    /// # Errors
    ///
    /// `update_artifact_sha256_mismatch` before anything is extracted; the
    /// archive, manifest and verification codes of the extracted tree; or
    /// `install_write_failed`.
    pub fn install_archive(
        &self,
        archive: &Path,
        expected_sha256: Option<&str>,
    ) -> Result<Installed, UpdateError> {
        if let Some(expected) = expected_sha256 {
            let actual = sha256_file(archive)
                .map_err(|error| UpdateError::caused(UpdateCode::InstallWriteFailed, error))?;
            if !actual.eq_ignore_ascii_case(expected) {
                return Err(UpdateCode::UpdateArtifactSha256Mismatch.into());
            }
        }
        let staging = Staging::create(self.home.root())?;
        extract(archive, staging.path())?;
        let manifest = verify_installation(staging.path())?;
        let dir = manifest.dir_name();
        let destination = self.home.version_path(&dir);
        let already_installed = destination.exists() && verify_installation(&destination).is_ok();
        if !already_installed {
            if destination.exists() {
                self.ensure_replaceable(&dir)?;
                remove_tree(&destination)?;
            }
            fs::rename(staging.path(), &destination)
                .map_err(|error| UpdateError::caused(UpdateCode::InstallWriteFailed, error))?;
            staging.disarm();
        }
        Ok(Installed {
            dir,
            version: manifest.version,
            path: destination,
            already_installed,
        })
    }

    /// A damaged version directory may be replaced unless it is the active
    /// or previous version, which are never modified.
    fn ensure_replaceable(&self, dir: &str) -> Result<(), UpdateError> {
        let in_use = [self.home.active()?, self.home.previous()?];
        if in_use.iter().flatten().any(|used| used == dir) {
            return Err(UpdateCode::InstallVerificationFailed.into());
        }
        Ok(())
    }

    /// Makes `dir` the active version and the version that was active the
    /// previous one. `previous` is written first, so an interruption between
    /// the two writes leaves the old version active.
    ///
    /// # Errors
    ///
    /// `install_version_not_found` when `dir` is not an installed version,
    /// `install_switch_failed` when a pointer cannot be written.
    pub fn activate(&self, dir: &str) -> Result<Switched, UpdateError> {
        let target = self.home.find(dir)?;
        let replaced = self.home.active()?;
        if replaced.as_deref() == Some(target.dir.as_str()) {
            return Ok(Switched {
                active: target.dir,
                previous: self.home.previous()?,
                replaced,
                changed: false,
            });
        }
        if let Some(old) = &replaced {
            point(self.home.root(), PREVIOUS, old)?;
        }
        point(self.home.root(), CURRENT, &target.dir)?;
        Ok(Switched {
            active: target.dir,
            previous: self.home.previous()?,
            replaced,
            changed: true,
        })
    }

    /// Makes no version active: removes `current` (never what it names).
    ///
    /// # Errors
    ///
    /// `install_switch_failed` when `current` is not a pointer or cannot be
    /// removed.
    pub fn deactivate(&self) -> Result<(), UpdateError> {
        install_link::remove(self.home.root(), CURRENT)
            .map_err(|error| UpdateError::caused(UpdateCode::InstallSwitchFailed, error))
    }

    /// Switches `current` to the `previous` version, or to the version `to`
    /// names. The version that was active becomes `previous`, so a second
    /// rollback returns to it.
    ///
    /// # Errors
    ///
    /// `install_nothing_to_roll_back` without a `previous` version and
    /// without `to`; the lookup codes of [`AgentHome::find`].
    pub fn rollback(&self, to: Option<&str>) -> Result<Switched, UpdateError> {
        let target = self.home.rollback_target(to)?;
        self.activate(&target.dir)
    }

    /// Removes old version directories, keeping the `keep` most recently
    /// installed, the active and previous versions, and every version a path
    /// of `protected` (a running executable, say) lies in. Leftover staging
    /// directories of interrupted installs go too. Returns the removed
    /// directory names.
    ///
    /// # Errors
    ///
    /// `install_write_failed` when a directory cannot be removed.
    pub fn prune(&self, keep: usize, protected: &[PathBuf]) -> Result<Vec<String>, UpdateError> {
        // Directories an earlier installer made are never touched.
        let versions: Vec<_> = self
            .home
            .versions()?
            .into_iter()
            .filter(|version| !version.legacy)
            .collect();
        let mut retained: HashSet<&str> = versions
            .iter()
            .take(keep)
            .map(|version| version.dir.as_str())
            .collect();
        retained.extend(
            versions
                .iter()
                .filter(|version| {
                    version.active
                        || version.previous
                        || uses_version(protected, &self.home.version_path(&version.dir))
                })
                .map(|version| version.dir.as_str()),
        );
        let mut removed = Vec::new();
        for version in versions
            .iter()
            .filter(|v| !retained.contains(v.dir.as_str()))
        {
            remove_tree(&self.home.version_path(&version.dir))?;
            removed.push(version.dir.clone());
        }
        self.remove_staging(STALE_STAGING)?;
        Ok(removed)
    }

    /// Removes staging directories left by interrupted installs. A directory
    /// touched within `min_age` may belong to an installer that does not take
    /// this lock (`install.sh`), so it stays; `Duration::ZERO` removes all.
    pub(super) fn remove_staging(&self, min_age: Duration) -> Result<(), UpdateError> {
        let Ok(entries) = fs::read_dir(self.home.root()) else {
            return Ok(());
        };
        for entry in entries.flatten() {
            let is_staging = entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with(STAGING_PREFIX));
            let idle = entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .ok()
                .and_then(|modified| modified.elapsed().ok())
                .is_none_or(|elapsed| elapsed >= min_age);
            if is_staging && idle {
                remove_tree(&entry.path())?;
            }
        }
        Ok(())
    }
}

fn point(root: &Path, link: &str, dir: &str) -> Result<(), UpdateError> {
    install_link::point(root, link, dir)
        .map_err(|error| UpdateError::caused(UpdateCode::InstallSwitchFailed, error))
}

/// Whether any protected path lies in the version directory, compared after
/// resolving links on both sides (`/var` is `/private/var` on macOS).
fn uses_version(protected: &[PathBuf], version_path: &Path) -> bool {
    let resolved = |path: &Path| path.canonical().unwrap_or_else(|_| path.to_path_buf());
    let version_path = resolved(version_path);
    protected
        .iter()
        .any(|path| resolved(path).starts_with(&version_path))
}

/// Removes a directory tree without following symbolic links, read-only
/// (archive-extracted) entries included.
pub(super) fn remove_tree(path: &Path) -> Result<(), UpdateError> {
    secure_fs::remove_tree(path)
        .map_err(|error| UpdateError::caused(UpdateCode::InstallWriteFailed, error))
}

/// A directory the archive is extracted into, removed unless it was moved
/// into place.
struct Staging {
    path: PathBuf,
    armed: bool,
}

impl Staging {
    fn create(root: &Path) -> Result<Self, UpdateError> {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_nanos());
        let path = root.join(format!("{STAGING_PREFIX}{}-{nanos}", std::process::id()));
        fs::create_dir(&path)
            .map_err(|error| UpdateError::caused(UpdateCode::InstallWriteFailed, error))?;
        Ok(Self { path, armed: true })
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn disarm(mut self) {
        self.armed = false;
    }
}

impl Drop for Staging {
    fn drop(&mut self) {
        if self.armed {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}
