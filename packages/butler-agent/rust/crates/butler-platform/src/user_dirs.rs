//! The user's directories, and the system's.
//!
//! Every host reads `HOME` first, so a caller (or a test) that sets `HOME`
//! decides the home directory everywhere; `USERPROFILE`, the Windows home,
//! is the fallback.

use std::env;
use std::path::{Path, PathBuf};

/// The user's home directory: `HOME`, else `USERPROFILE`, as set (an empty
/// value included); `None` when neither is set.
pub fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// [`home_dir`], unless it is set but empty.
pub fn non_empty_home_dir() -> Option<PathBuf> {
    home_dir().filter(|home| !home.as_os_str().is_empty())
}

/// Names the directory the CLI installs the Agent into. Set, non-empty and
/// absolute, it replaces the per-OS default of [`agent_home`].
pub const AGENT_HOME_VARIABLE: &str = "BUTLER_AGENT_HOME";

/// Where the CLI installs the Agent: [`AGENT_HOME_VARIABLE`], else the
/// per-OS default. The default is `~/Applications/ButlerAgent` on macOS,
/// `${XDG_DATA_HOME:-~/.local/share}/butler/agent` on other Unix hosts and
/// `%LOCALAPPDATA%\Butler\agent` on Windows. `None` when the variable is
/// unset and the host names no default (no home directory).
pub fn agent_home() -> Option<PathBuf> {
    let configured = env::var_os(AGENT_HOME_VARIABLE)
        .map(PathBuf::from)
        .filter(|path| path.is_absolute());
    configured.or_else(default_agent_home)
}

/// Names the directory of the user's `butler` command. Set, non-empty and
/// absolute, it replaces the per-OS default of [`command_dir`].
pub const COMMAND_DIR_VARIABLE: &str = "BUTLER_BIN_DIR";

/// The directory of the user's `butler` command, which the installer puts on
/// the user's `PATH`: [`COMMAND_DIR_VARIABLE`], else `~/.local/bin` on Unix
/// and `%LOCALAPPDATA%\Butler\bin` on Windows. `None` without a home
/// directory.
pub fn command_dir() -> Option<PathBuf> {
    env::var_os(COMMAND_DIR_VARIABLE)
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(default_command_dir)
}

/// Whether `path` is a file-system root or lies in the operating system's
/// own folders, which no user project may claim: `/` and `/System`, `/etc`,
/// `/private/etc`, `/bin`, `/sbin` on Unix; a drive root and the
/// `SystemRoot`, `ProgramFiles` and `ProgramFiles(x86)` folders on Windows.
pub fn is_system_folder(path: &Path) -> bool {
    if path.has_root() && path.parent().is_none() {
        return true;
    }
    system_roots().iter().any(|root| path.starts_with(root))
}

#[cfg(unix)]
fn system_roots() -> Vec<PathBuf> {
    ["/System", "/etc", "/private/etc", "/bin", "/sbin"]
        .into_iter()
        .map(PathBuf::from)
        .collect()
}

#[cfg(windows)]
fn system_roots() -> Vec<PathBuf> {
    ["SystemRoot", "ProgramFiles", "ProgramFiles(x86)"]
        .into_iter()
        .filter_map(env::var_os)
        .filter(|root| !root.is_empty())
        .map(PathBuf::from)
        .collect()
}

#[cfg(unix)]
fn non_empty_home() -> Option<PathBuf> {
    home_dir().filter(|home| !home.as_os_str().is_empty())
}

#[cfg(target_os = "macos")]
fn default_agent_home() -> Option<PathBuf> {
    Some(non_empty_home()?.join("Applications").join("ButlerAgent"))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn default_agent_home() -> Option<PathBuf> {
    let data_home = env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(|| Some(non_empty_home()?.join(".local").join("share")))?;
    Some(data_home.join("butler").join("agent"))
}

#[cfg(windows)]
fn default_agent_home() -> Option<PathBuf> {
    Some(windows_butler_dir()?.join("agent"))
}

#[cfg(unix)]
fn default_command_dir() -> Option<PathBuf> {
    Some(non_empty_home()?.join(".local").join("bin"))
}

#[cfg(windows)]
fn default_command_dir() -> Option<PathBuf> {
    Some(windows_butler_dir()?.join("bin"))
}

#[cfg(windows)]
fn windows_butler_dir() -> Option<PathBuf> {
    env::var_os("LOCALAPPDATA")
        .filter(|path| !path.is_empty())
        .map(|path| PathBuf::from(path).join("Butler"))
}
