//! The installed App's own layout: where it keeps its resources, the installation root its
//! bundled Agent must stay inside, and whether this build may register itself with the OS
//! (login item, notifications). Electron's `installShellRegistrationAllowed`.
use std::path::{Path, PathBuf};

/// Electron's Windows AppUserModelID and login Run value name.
pub const WINDOWS_APP_ID: &str = "com.squirrel.butler-app.Butler";

/// Registrations name the Squirrel stub so they survive updates (Electron
/// `windowsLoginItemSettings`); other layouts keep the executable itself.
pub fn launcher(executable: &Path) -> PathBuf {
    #[cfg(windows)]
    if let Some(root) = executable.parent().and_then(Path::parent)
        && root.join("Update.exe").is_file()
        && let Some(name) = executable.file_name()
    {
        return root.join(name);
    }
    executable.to_path_buf()
}

/// Set to `1`, the App registers nothing with the OS (every check sets it).
const DISABLE_REGISTRATION: &str = "BUTLER_APP_DISABLE_SHELL_REGISTRATION";

/// The `.app` bundle an executable at `<X.app>/Contents/MacOS/<exe>` belongs to.
#[cfg(target_os = "macos")]
fn app_bundle(executable: &Path) -> Option<&Path> {
    let macos = executable.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    (macos.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && bundle.extension()? == "app")
        .then_some(bundle)
}

/// The installation root the bundled Agent must stay inside: macOS the `.app` bundle;
/// Windows and Linux the executable's folder.
pub fn installation_root(executable: &Path) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    let root = app_bundle(executable);
    #[cfg(not(target_os = "macos"))]
    let root = executable.parent();
    root.map(Path::to_path_buf)
}

/// Where an installed App keeps its resources, from its executable: macOS
/// `<X.app>/Contents/Resources`; Windows and Linux `<exe dir>/resources`. `None` when
/// `executable` is not inside such a layout.
pub fn bundled_resources(executable: &Path) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    let resources = app_bundle(executable)?.join("Contents").join("Resources");
    #[cfg(not(target_os = "macos"))]
    let resources = executable.parent()?.join("resources");
    resources.is_dir().then_some(resources)
}

/// A packaged App: `bundled_resources(executable)/bundled-agent` exists and
/// `BUTLER_APP_DISABLE_SHELL_REGISTRATION` is not `1`. The login item and notifications gate
/// on it.
pub fn shell_registration_allowed(executable: &Path) -> bool {
    std::env::var(DISABLE_REGISTRATION).ok().as_deref() != Some("1")
        && bundled_resources(executable)
            .is_some_and(|resources| resources.join("bundled-agent").is_dir())
}
