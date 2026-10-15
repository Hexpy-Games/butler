//! Platform-owned profile locations.
use super::ProfileRoots;
use crate::account_dirs::AccountDirs;
use std::path::Path;
/// This operating system's browser locations in the account folders.
#[cfg(target_os = "macos")]
pub fn roots_in(dirs: &AccountDirs) -> ProfileRoots {
    let (home, base) = (&dirs.home, &dirs.app_data);
    ProfileRoots {
        chromium: vec![
            ("chrome", base.join("Google/Chrome")),
            ("edge", base.join("Microsoft Edge")),
            ("brave", base.join("BraveSoftware/Brave-Browser")),
            ("whale", base.join("Naver/Whale")),
            ("arc", base.join("Arc/User Data")),
            ("chromium", base.join("Chromium")),
        ],
        firefox: base.join("Firefox/Profiles"),
        safari: Some(home.join("Library/Safari/Bookmarks.plist")),
    }
}

/// This operating system's browser locations in the account folders.
#[cfg(windows)]
pub fn roots_in(dirs: &AccountDirs) -> ProfileRoots {
    let local = &dirs.local_app_data;
    ProfileRoots {
        chromium: vec![
            ("chrome", local.join("Google\\Chrome\\User Data")),
            ("edge", local.join("Microsoft\\Edge\\User Data")),
            (
                "brave",
                local.join("BraveSoftware\\Brave-Browser\\User Data"),
            ),
            ("whale", local.join("Naver\\Naver Whale\\User Data")),
            ("chromium", local.join("Chromium\\User Data")),
            ("arc", local.join("Packages\\TheBrowserCompany.Arc_ttt1ap7aakyb4\\LocalCache\\Local\\Arc\\User Data")),
        ],
        firefox: dirs.app_data.join("Mozilla\\Firefox\\Profiles"),
        safari: None,
    }
}

/// This operating system's browser locations in the account folders.
#[cfg(all(unix, not(target_os = "macos")))]
pub fn roots_in(dirs: &AccountDirs) -> ProfileRoots {
    let (home, config) = (&dirs.home, &dirs.app_data);
    ProfileRoots {
        chromium: vec![
            ("chrome", config.join("google-chrome")),
            ("edge", config.join("microsoft-edge")),
            ("brave", config.join("BraveSoftware/Brave-Browser")),
            ("whale", config.join("naver-whale")),
            ("chromium", config.join("chromium")),
        ],
        firefox: home.join(".mozilla/firefox"),
        safari: None,
    }
}

/// [`roots_in`] for the default layout under `home`, for fixtures.
pub fn profile_roots(home: &Path) -> ProfileRoots {
    roots_in(&AccountDirs::under(home))
}
