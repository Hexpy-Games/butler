//! Profile roots for an isolated child, never inherited from the owner.
use std::path::{Path, PathBuf};

/// The caller creates these directories before launching the child.
pub fn fixture_profile_environment(home: &Path) -> Vec<(&'static str, PathBuf)> {
    #[cfg(windows)]
    return vec![
        ("USERPROFILE", home.to_owned()),
        ("APPDATA", home.join("AppData/Roaming")),
        ("LOCALAPPDATA", home.join("AppData/Local")),
    ];
    #[cfg(not(windows))]
    {
        let _ = home;
        Vec::new()
    }
}
