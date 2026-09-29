//! The `butler` launcher kept in the data folder, `DATA/bin/butler`.
//!
//! **One canonical launcher.** The `butler` command of a CLI installation is
//! `~/.local/bin/butler` (see `AgentHome::sync_command_launcher`): it runs
//! `AGENT_HOME/current`, whichever version that names. `DATA/bin/butler` is
//! the older location, kept so a `PATH` that still names it keeps working.
//! It is the same launcher script with two differences: it selects this data
//! folder when the caller names none, and it is repointed by two writers:
//! `butler install`, `update` and `rollback` point it at `AGENT_HOME/current`,
//! and every service start points it at the installation that service runs
//! (the App's bundled Agent when the App chose that over the CLI
//! installation), so it always runs the Agent that serves this data folder.
//!
//! Releases before the native cutover installed a Bun-compiled launcher here
//! that runs `$BUTLER_HOME/bin/butler.js`; that script no longer exists, so
//! every `butler ...` command failed with "Module not found". An installed
//! Butler (one with its payload manifest) repairs the path: it rewrites that
//! stale launcher, or a launcher of its own (marked in its second line), and
//! keeps the first stale launcher as `butler.previous`; an existing
//! `butler.previous` is never overwritten. Any other file is the user's and
//! is left alone, and a development build never touches the path.

use std::path::{Path, PathBuf};

use butler_platform::command_launcher::{self, Ownership, Target};
use butler_runtime::operations::AgentHome;

use crate::host::ResolvedInstallation;

/// What [`repair`] did to `DATA/bin/butler`.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum LauncherRepair {
    /// No launcher was installed at `DATA/bin/butler`.
    Absent,
    /// This is not an installed Butler (no payload manifest): the launcher is
    /// not touched.
    NotInstalled,
    /// The launcher already runs the right Agent.
    Current,
    /// An older native launcher pointed at another installation.
    Updated,
    /// The stale pre-native launcher was replaced.
    ReplacedStale,
    /// The file is neither ours nor the stale launcher: left alone.
    Foreign,
}

impl LauncherRepair {
    /// The state in output and JSON.
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            Self::Absent => "absent",
            Self::NotInstalled => "not-installed",
            Self::Current => "current",
            Self::Updated => "updated",
            Self::ReplacedStale => "replaced-stale",
            Self::Foreign => "kept-foreign",
        }
    }
}

/// The launcher path in a data folder.
pub(crate) fn data_launcher_path(data_root: &Path) -> PathBuf {
    data_root.join("bin").join(command_launcher::file_name())
}

/// Rewrites a stale or outdated `DATA/bin/butler` so it runs the CLI
/// installation, or `installation` when there is none. An absent launcher is
/// not created.
pub(crate) fn repair(
    data_root: &Path,
    installation: &ResolvedInstallation,
) -> std::io::Result<LauncherRepair> {
    if !matches!(installation.payload_provenance(), Ok(Some(_))) {
        // Still report a missing launcher as such.
        return Ok(
            match command_launcher::ownership(&data_launcher_path(data_root))? {
                None => LauncherRepair::Absent,
                Some(_) => LauncherRepair::NotInstalled,
            },
        );
    }
    // The installation that runs is the one the App (or the CLI) chose, which
    // is not always the CLI installation: the App launches the newer of its
    // bundled Agent and `AGENT_HOME/current`.
    rewrite(data_root, &LaunchPaths::of(installation))
}

/// [`repair`] for a command that just changed the CLI installation, when no
/// running installation is at hand.
pub(crate) fn point_at_agent_home(
    data_root: &Path,
    home: &AgentHome,
) -> std::io::Result<LauncherRepair> {
    let target = home.launcher_target();
    rewrite(
        data_root,
        &LaunchPaths {
            program: target.program,
            root: target.root,
            resources: target.resources,
        },
    )
}

/// The executable, installation root and resource root a launcher (or a
/// login service definition) runs.
struct LaunchPaths {
    program: PathBuf,
    root: PathBuf,
    resources: PathBuf,
}

impl LaunchPaths {
    /// The running installation.
    fn of(installation: &ResolvedInstallation) -> Self {
        Self {
            program: installation.executable().to_path_buf(),
            root: installation.root().to_path_buf(),
            resources: installation.resources().to_path_buf(),
        }
    }
}

fn rewrite(data_root: &Path, paths: &LaunchPaths) -> std::io::Result<LauncherRepair> {
    let launcher = data_launcher_path(data_root);
    let Some(ownership) = command_launcher::ownership(&launcher)? else {
        return Ok(LauncherRepair::Absent);
    };
    let wanted = command_launcher::render(&Target {
        program: &paths.program,
        installation_root: &paths.root,
        resource_root: &paths.resources,
        data_default: Some(data_root),
    });
    match ownership {
        Ownership::Foreign => return Ok(LauncherRepair::Foreign),
        Ownership::Ours if command_launcher::is_current(&launcher, &wanted) => {
            return Ok(LauncherRepair::Current);
        }
        Ownership::Stale => command_launcher::keep_previous(&launcher)?,
        Ownership::Ours => {}
    }
    command_launcher::write(&launcher, &wanted)?;
    Ok(if ownership == Ownership::Ours {
        LauncherRepair::Updated
    } else {
        LauncherRepair::ReplacedStale
    })
}

/// Removes `DATA/bin/butler` when it is Butler's launcher; whether it did.
pub(crate) fn remove(data_root: &Path) -> std::io::Result<bool> {
    let launcher = data_launcher_path(data_root);
    Ok(command_launcher::remove_if_ours(&launcher)? == command_launcher::Removal::Removed)
}
