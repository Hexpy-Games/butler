//! Platform-owned profile locations.
use super::ProfileRoots;
use std::path::Path;
/// This operating system's browser locations under `home`.
#[cfg(target_os = "macos")]
pub fn profile_roots(home: &Path) -> ProfileRoots {
    let base = home.join("Library").join("Application Support");
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

/// This operating system's browser locations under `home`.
#[cfg(windows)]
pub fn profile_roots(home: &Path) -> ProfileRoots {
    let local = home.join("AppData").join("Local");
    ProfileRoots {
        chromium: vec![
            ("chrome", local.join("Google\\Chrome\\User Data")),
            ("edge", local.join("Microsoft\\Edge\\User Data")),
            (
                "brave",
                local.join("BraveSoftware\\Brave-Browser\\User Data"),
            ),
            ("whale", local.join("Naver\\Naver Whale\\User Data")),
        ],
        firefox: home.join("AppData\\Roaming\\Mozilla\\Firefox\\Profiles"),
        safari: None,
    }
}

/// This operating system's browser locations under `home`.
#[cfg(all(unix, not(target_os = "macos")))]
pub fn profile_roots(home: &Path) -> ProfileRoots {
    let config = home.join(".config");
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
