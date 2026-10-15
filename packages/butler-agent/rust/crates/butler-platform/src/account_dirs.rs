//! The signed-in account's own folders, as the operating system records them.
//!
//! Reading another app's data (a browser profile, say) must find the folders
//! that app writes to, even when this process runs with a redirected `HOME`,
//! `LOCALAPPDATA` or `APPDATA` (an isolated or demo run). So these come from
//! the account database on Unix and recorded shell folders on Windows, never
//! from environment variables. Butler's own folders stay in [`crate::user_dirs`].

use std::path::{Path, PathBuf};

/// Where an app keeps per-user data.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountDirs {
    /// The account home folder.
    pub home: PathBuf,
    /// Roaming app data: `~/Library/Application Support` on macOS,
    /// `%APPDATA%` (Roaming) on Windows, `~/.config` elsewhere.
    pub app_data: PathBuf,
    /// Machine-local app data: `%LOCALAPPDATA%` on Windows, otherwise
    /// [`Self::app_data`].
    pub local_app_data: PathBuf,
}

impl AccountDirs {
    /// The default layout of this operating system under `home`, for fixtures.
    pub fn under(home: &Path) -> Self {
        let (app_data, local_app_data) = default_layout(home);
        Self {
            home: home.to_path_buf(),
            app_data,
            local_app_data,
        }
    }
}

/// One folder serves both kinds on macOS.
#[cfg(target_os = "macos")]
fn default_layout(root: &Path) -> (PathBuf, PathBuf) {
    let support = root.join(MAC_SUPPORT);
    (support.clone(), support)
}

/// Roaming and local app data share one folder on macOS.
#[cfg(target_os = "macos")]
const MAC_SUPPORT: &str = "Library/Application Support";

/// Roaming and local app data under the profile folder.
#[cfg(windows)]
const WINDOWS_DATA: [&str; 2] = ["AppData/Roaming", "AppData/Local"];

/// Roaming and local app data under the profile folder.
#[cfg(windows)]
fn default_layout(root: &Path) -> (PathBuf, PathBuf) {
    (root.join(WINDOWS_DATA[0]), root.join(WINDOWS_DATA[1]))
}

/// One configuration folder serves both kinds elsewhere.
#[cfg(all(unix, not(target_os = "macos")))]
const UNIX_CONFIG: &str = ".config";

/// One configuration folder serves both kinds elsewhere.
#[cfg(all(unix, not(target_os = "macos")))]
fn default_layout(root: &Path) -> (PathBuf, PathBuf) {
    let config = root.join(UNIX_CONFIG);
    (config.clone(), config)
}

/// This account's folders; `None` when the system cannot name its home.
#[cfg(unix)]
pub fn account_dirs() -> Option<AccountDirs> {
    let user = nix::unistd::User::from_uid(nix::unistd::getuid()).ok()??;
    Some(user.dir)
        .filter(|home| home.is_absolute())
        .map(|home| AccountDirs::under(&home))
}

/// This account's folders; `None` when a recorded folder is unavailable.
#[cfg(windows)]
pub fn account_dirs() -> Option<AccountDirs> {
    use winsafe::{SHGetKnownFolderPath, co};
    let known = |id: &co::KNOWNFOLDERID| {
        SHGetKnownFolderPath(id, co::KF::DEFAULT, None)
            .ok()
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
    };
    // Known-folder resolution expands process environment variables for app
    // data. Read the shell's already-expanded account paths first so a redirected
    // profile cannot hide the real installations or browser profiles.
    Some(AccountDirs {
        home: known(&co::KNOWNFOLDERID::Profile)?,
        app_data: recorded_shell_folder("AppData")
            .or_else(|| known(&co::KNOWNFOLDERID::RoamingAppData))?,
        local_app_data: recorded_shell_folder("Local AppData")
            .or_else(|| known(&co::KNOWNFOLDERID::LocalAppData))?,
    })
}

#[cfg(windows)]
fn recorded_shell_folder(name: &str) -> Option<PathBuf> {
    use winsafe::{HKEY, RegistryValue, co};
    let key = HKEY::CURRENT_USER
        .RegOpenKeyEx(
            Some(r"Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders"),
            co::REG_OPTION::NON_VOLATILE,
            co::KEY::READ,
        )
        .ok()?;
    let RegistryValue::Sz(value) = key.RegQueryValueEx(Some(name)).ok()? else {
        return None;
    };
    let path = PathBuf::from(value);
    path.is_absolute().then_some(path)
}
