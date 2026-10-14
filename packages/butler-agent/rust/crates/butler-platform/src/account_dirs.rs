//! The signed-in account's own folders, as the operating system records them.
//!
//! Reading another app's data (a browser profile, say) must find the folders
//! that app writes to, even when this process runs with a redirected `HOME`,
//! `LOCALAPPDATA` or `APPDATA` (an isolated or demo run). So these come from
//! the account database on Unix and the known-folder API on Windows, never
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

/// This account's folders; `None` when a known folder is unavailable.
#[cfg(windows)]
pub fn account_dirs() -> Option<AccountDirs> {
    use winsafe::{SHGetKnownFolderPath, co};
    let known = |id: &co::KNOWNFOLDERID| {
        SHGetKnownFolderPath(id, co::KF::DEFAULT, None)
            .ok()
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
    };
    Some(AccountDirs {
        home: known(&co::KNOWNFOLDERID::Profile)?,
        app_data: known(&co::KNOWNFOLDERID::RoamingAppData)?,
        local_app_data: known(&co::KNOWNFOLDERID::LocalAppData)?,
    })
}
