//! Other browsers' profiles on this computer, for importing bookmarks: where
//! each browser keeps them on this operating system, and reading Safari's
//! binary property list. Reads only; nothing here writes a browser's files.

use std::io;
use std::path::{Path, PathBuf};

/// How a profile's bookmarks are stored.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BookmarkFormat {
    /// Chromium's `Bookmarks` JSON (Chrome, Edge, Brave, Whale).
    Chromium,
    /// Firefox's `places.sqlite`.
    Firefox,
    /// Safari's `Bookmarks.plist`.
    Safari,
}

/// One browser profile that has bookmarks.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BrowserProfile {
    /// `chrome`, `edge`, `brave`, `whale`, `firefox` or `safari`.
    pub browser: &'static str,
    /// The profile's directory name (a stable id within the browser).
    pub id: String,
    /// The name the browser shows for the profile.
    pub name: String,
    /// The bookmarks file.
    pub bookmarks: PathBuf,
    /// Its format.
    pub format: BookmarkFormat,
}

/// Where each browser keeps its profiles under a home directory.
#[derive(Clone, Debug)]
pub struct ProfileRoots {
    /// Chromium-family user-data folders by browser.
    pub chromium: Vec<(&'static str, PathBuf)>,
    /// Firefox's profiles folder.
    pub firefox: PathBuf,
    /// Safari's bookmarks file (macOS only).
    pub safari: Option<PathBuf>,
}

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
        ],
        firefox: home.join(".mozilla/firefox"),
        safari: None,
    }
}

/// The installed browsers' profiles under the user's home that have bookmarks.
pub fn detect() -> Vec<BrowserProfile> {
    let Some(home) = crate::user_dirs::non_empty_home_dir() else {
        return Vec::new();
    };
    let roots = profile_roots(&home);
    let mut profiles = Vec::new();
    for (browser, root) in &roots.chromium {
        profiles.extend(chromium_profiles(browser, root));
    }
    profiles.extend(firefox_profiles(&roots.firefox));
    if let Some(path) = roots.safari.filter(|path| path.exists()) {
        profiles.push(BrowserProfile {
            browser: "safari",
            id: "default".into(),
            name: "Safari".into(),
            bookmarks: path,
            format: BookmarkFormat::Safari,
        });
    }
    profiles
}

fn chromium_profiles(browser: &'static str, root: &Path) -> Vec<BrowserProfile> {
    let names = std::fs::read(root.join("Local State"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut profiles: Vec<BrowserProfile> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let id = entry.file_name().to_string_lossy().into_owned();
            let bookmarks = entry.path().join("Bookmarks");
            if !(id == "Default" || id.starts_with("Profile ")) || !bookmarks.is_file() {
                return None;
            }
            let name = names
                .as_ref()
                .and_then(|state| state.pointer(&format!("/profile/info_cache/{id}/name")))
                .and_then(serde_json::Value::as_str)
                .unwrap_or(&id)
                .to_owned();
            Some(BrowserProfile {
                browser,
                id,
                name,
                bookmarks,
                format: BookmarkFormat::Chromium,
            })
        })
        .collect();
    profiles.sort_by(|a, b| a.id.cmp(&b.id));
    profiles
}

fn firefox_profiles(root: &Path) -> Vec<BrowserProfile> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut profiles: Vec<BrowserProfile> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let id = entry.file_name().to_string_lossy().into_owned();
            let bookmarks = entry.path().join("places.sqlite");
            bookmarks.is_file().then(|| BrowserProfile {
                browser: "firefox",
                name: id
                    .split_once('.')
                    .map_or(id.as_str(), |(_, name)| name)
                    .to_owned(),
                id,
                bookmarks,
                format: BookmarkFormat::Firefox,
            })
        })
        .collect();
    profiles.sort_by(|a, b| a.id.cmp(&b.id));
    profiles
}

/// Safari's bookmarks as an XML property list. Reading them needs Full Disk
/// Access for this app; without it the error is `PermissionDenied`.
#[cfg(target_os = "macos")]
pub fn read_safari_bookmarks(path: &Path) -> io::Result<String> {
    // Probe the read first: plutil would only report a generic failure.
    std::fs::File::open(path)?;
    let output = std::process::Command::new("/usr/bin/plutil")
        .args(["-convert", "xml1", "-o", "-"])
        .arg(path)
        .output()?;
    if !output.status.success() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "bookmarks list unreadable",
        ));
    }
    String::from_utf8(output.stdout).map_err(|_| io::Error::from(io::ErrorKind::InvalidData))
}

/// Safari's bookmarks exist only on macOS.
#[cfg(not(target_os = "macos"))]
pub fn read_safari_bookmarks(_path: &Path) -> io::Result<String> {
    Err(io::Error::from(io::ErrorKind::Unsupported))
}
