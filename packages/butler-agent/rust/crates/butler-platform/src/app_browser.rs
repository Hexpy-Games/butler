//! The installed Butler App's own Electron, run without a window as a browser
//! host while the App itself is not running.
//!
//! Discovery knows where each OS keeps the App: beside the Agent when the Agent
//! is the App's bundled one, then the usual install location (a macOS app
//! bundle, the per-user Squirrel install on Windows). Nothing is installed or
//! changed. The host runs as one contained process tree (a process group, a
//! Job Object on Windows) with its output appended to a log file; ending it
//! ends every Electron helper with it.

use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use crate::process_control::{self, GroupSignal};

/// An Electron that can run the App's browser host.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppElectron {
    /// The App's executable (or a development Electron).
    pub executable: PathBuf,
    /// The App directory a development Electron loads; `None` for a packaged
    /// App, which loads its own.
    pub app_dir: Option<PathBuf>,
}

impl AppElectron {
    /// Whether the executable (and the App directory, when named) exist.
    pub fn exists(&self) -> bool {
        self.executable.is_file() && self.app_dir.as_deref().is_none_or(Path::is_dir)
    }
}

/// The installed App's Electron: the App this Agent came with, else the
/// App in its usual install location. `None` when no App is installed.
pub fn installed_app() -> Option<AppElectron> {
    let agent = std::env::current_exe().ok();
    agent
        .as_deref()
        .and_then(bundled_with)
        .into_iter()
        .chain(standard_locations())
        .map(|executable| AppElectron {
            executable,
            app_dir: None,
        })
        .find(AppElectron::exists)
}

/// The App executable of an Agent bundled inside it:
/// `<App>/…/resources/bundled-agent/bin/butler-agent`.
fn bundled_with(agent: &Path) -> Option<PathBuf> {
    let bin = agent.parent()?;
    let payload = bin.parent()?;
    let resources = payload.parent()?;
    let named = |path: &Path, name: &str| {
        path.file_name()
            .is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case(name))
    };
    if !named(bin, "bin") || !named(payload, "bundled-agent") || !named(resources, "resources") {
        return None;
    }
    sys::app_from_resources(resources)
}

fn standard_locations() -> Vec<PathBuf> {
    sys::standard_locations()
}

#[cfg(target_os = "macos")]
mod sys {
    use std::path::{Path, PathBuf};

    const BUNDLE: &str = "Butler.app";

    fn executable(bundle: &Path) -> PathBuf {
        bundle.join("Contents/MacOS/Butler")
    }

    /// `<Butler.app>/Contents/Resources`.
    pub(super) fn app_from_resources(resources: &Path) -> Option<PathBuf> {
        Some(executable(resources.parent()?.parent()?))
    }

    pub(super) fn standard_locations() -> Vec<PathBuf> {
        let mut bundles = vec![Path::new("/Applications").join(BUNDLE)];
        if let Some(home) = crate::user_dirs::non_empty_home_dir() {
            bundles.push(home.join("Applications").join(BUNDLE));
        }
        bundles
            .iter()
            .map(PathBuf::as_path)
            .map(executable)
            .collect()
    }
}

#[cfg(windows)]
mod sys {
    use std::path::{Path, PathBuf};

    const EXECUTABLE: &str = "Butler.exe";

    /// `<root>\app-<version>\resources`.
    pub(super) fn app_from_resources(resources: &Path) -> Option<PathBuf> {
        Some(resources.parent()?.join(EXECUTABLE))
    }

    /// The newest `%LOCALAPPDATA%\butler-app\app-<version>\Butler.exe`: the
    /// Squirrel root's stub would start a detached child, so the versioned
    /// executable runs directly.
    pub(super) fn standard_locations() -> Vec<PathBuf> {
        let Some(root) = std::env::var_os("LOCALAPPDATA")
            .filter(|path| !path.is_empty())
            .map(|path| PathBuf::from(path).join("butler-app"))
        else {
            return Vec::new();
        };
        let mut versions: Vec<(Vec<u64>, PathBuf)> = std::fs::read_dir(&root)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|entry| {
                let name = entry.file_name().to_string_lossy().into_owned();
                let version = name.strip_prefix("app-")?;
                let parts = version
                    .split(['.', '-'])
                    .map_while(|part| part.parse::<u64>().ok())
                    .collect();
                Some((parts, entry.path().join(EXECUTABLE)))
            })
            .collect();
        versions.sort();
        versions.into_iter().rev().map(|(_, path)| path).collect()
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
mod sys {
    use std::path::{Path, PathBuf};

    /// `<dir>/resources` beside the packaged executable.
    pub(super) fn app_from_resources(resources: &Path) -> Option<PathBuf> {
        let dir = resources.parent()?;
        ["Butler", "butler"]
            .into_iter()
            .map(|name| dir.join(name))
            .find(|path| path.is_file())
    }

    /// Linux has no standard App install location.
    pub(super) fn standard_locations() -> Vec<PathBuf> {
        Vec::new()
    }
}

/// A running host: the leader of its contained process tree.
pub struct AppHostProcess {
    pid: u32,
    child: tokio::process::Child,
}

impl AppHostProcess {
    /// The host's process id (the leader of its tree).
    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// Waits until the host's leader exits.
    pub async fn wait(&mut self) {
        let _ = self.child.wait().await;
    }

    /// Waits up to `within` for the host to exit on its own; `true` once it did.
    pub async fn exited(&mut self, within: Duration) -> bool {
        tokio::time::timeout(within, self.child.wait())
            .await
            .is_ok()
    }

    /// Ends the whole tree now and reaps the leader.
    pub async fn kill(mut self) {
        let _ = process_control::signal_group(self.pid, GroupSignal::Kill);
        let _ = self.child.start_kill();
        let _ = self.child.wait().await;
    }
}

impl Drop for AppHostProcess {
    fn drop(&mut self) {
        let _ = process_control::signal_group(self.pid, GroupSignal::Kill);
    }
}

/// Starts `app` with `args` (after the App directory, when there is one)
/// and `env` added, in a contained tree of its own; stdin is closed and its
/// output is appended to `log`. Must be called within a Tokio runtime.
pub fn spawn(
    app: &AppElectron,
    args: &[OsString],
    env: &[(&str, &str)],
    log: &Path,
) -> io::Result<AppHostProcess> {
    let output = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log)?;
    let mut command = std::process::Command::new(&app.executable);
    if let Some(dir) = &app.app_dir {
        command.arg(dir);
    }
    command
        .args(args)
        .envs(env.iter().copied())
        // Would start a plain Node.js instead of the App.
        .env_remove("ELECTRON_RUN_AS_NODE")
        .stdin(Stdio::null())
        .stdout(Stdio::from(output.try_clone()?))
        .stderr(Stdio::from(output));
    process_control::hide_console(&mut command);
    if process_control::isolate_group(&mut command).is_none() {
        return Err(io::Error::other("process containment unavailable"));
    }
    let mut child = tokio::process::Command::from(command)
        .kill_on_drop(true)
        .spawn()?;
    let pid = child
        .id()
        .ok_or_else(|| io::Error::other("host exited at start"))?;
    if let Err(error) = process_control::contain(&child) {
        let _ = child.start_kill();
        return Err(error);
    }
    Ok(AppHostProcess { pid, child })
}
