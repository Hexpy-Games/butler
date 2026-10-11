//! Browser profile discovery and access probes. Never modifies source profiles.
mod roots;
pub use roots::profile_roots;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
/// Bookmark storage format.
pub enum BookmarkFormat {
    /// Chromium JSON.
    Chromium,
    /// Firefox SQLite.
    Firefox,
    /// Safari plist.
    Safari,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
/// Result of probing source access.
pub enum ProfileAccess {
    /// Readable.
    Ready,
    /// OS denied access, including silent EPERM.
    PermissionDenied,
    /// Not installed or absent.
    NotFound,
}
#[derive(Clone, Debug, PartialEq, Eq)]
/// A detected profile; paths stay in the native process.
pub struct BrowserProfile {
    /// Browser brand identifier.
    pub browser: &'static str,
    /// Stable profile identifier.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Bookmark file.
    pub bookmarks: PathBuf,
    /// Bookmark representation.
    pub format: BookmarkFormat,
    /// Observed source access.
    pub access: ProfileAccess,
}
#[derive(Clone, Debug)]
/// Platform browser data locations.
pub struct ProfileRoots {
    /// Chromium user-data directories.
    pub chromium: Vec<(&'static str, PathBuf)>,
    /// Firefox profiles directory.
    pub firefox: PathBuf,
    /// Safari bookmark file when supported.
    pub safari: Option<PathBuf>,
}

/// EPERM and EACCES remain distinct from a missing installation.
pub fn probe(path: &Path) -> ProfileAccess {
    #[cfg(feature = "test-support")]
    if let Some(denied) = std::env::var_os("BUTLER_BROWSER_IMPORT_DENIED_FIXTURE") {
        let denied = PathBuf::from(denied);
        if crate::user_dirs::non_empty_home_dir().is_some_and(|home| denied.starts_with(home))
            && path.starts_with(denied)
        {
            return ProfileAccess::PermissionDenied;
        }
    }
    let result = if path.is_dir() {
        std::fs::read_dir(path).map(|_| ())
    } else {
        std::fs::File::open(path).map(|_| ())
    };
    match result {
        Ok(()) => ProfileAccess::Ready,
        Err(e) if e.kind() == io::ErrorKind::PermissionDenied => ProfileAccess::PermissionDenied,
        Err(_) => ProfileAccess::NotFound,
    }
}

/// Installed profiles under the current home.
pub fn detect() -> Vec<BrowserProfile> {
    crate::user_dirs::non_empty_home_dir()
        .map(|home| detect_at(&home))
        .unwrap_or_default()
}

/// Also used by fixture callers; every path is rooted in the supplied home.
pub fn detect_at(home: &Path) -> Vec<BrowserProfile> {
    let roots = profile_roots(home);
    let mut profiles = Vec::new();
    for (browser, root) in &roots.chromium {
        profiles.extend(chromium_profiles(browser, root));
    }
    profiles.extend(firefox_profiles("firefox", &roots.firefox));
    profiles.extend(firefox_profiles("zen", &zen_root(home)));
    if let Some(path) = roots.safari {
        let access = probe(&path);
        if access != ProfileAccess::NotFound {
            profiles.push(BrowserProfile {
                browser: "safari",
                id: "default".into(),
                name: "Safari".into(),
                bookmarks: path,
                format: BookmarkFormat::Safari,
                access,
            });
        }
    }
    profiles
}

fn blocked(browser: &'static str, root: &Path, format: BookmarkFormat) -> BrowserProfile {
    BrowserProfile {
        browser,
        id: "blocked".into(),
        name: browser.into(),
        bookmarks: root.to_path_buf(),
        format,
        access: ProfileAccess::PermissionDenied,
    }
}

fn chromium_profiles(browser: &'static str, root: &Path) -> Vec<BrowserProfile> {
    let state = root.join("Local State");
    if probe(&state) == ProfileAccess::PermissionDenied
        || probe(root) == ProfileAccess::PermissionDenied
    {
        return vec![blocked(browser, root, BookmarkFormat::Chromium)];
    }
    let names = std::fs::read(state)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
    let Some(cache) = names
        .as_ref()
        .and_then(|v| v.pointer("/profile/info_cache"))
        .and_then(serde_json::Value::as_object)
    else {
        return Vec::new();
    };
    let mut profiles = Vec::new();
    for (id, info) in cache {
        if !safe_relative(id) {
            continue;
        }
        let bookmarks = root.join(id).join("Bookmarks");
        profiles.push(BrowserProfile {
            browser,
            id: id.clone(),
            name: info["name"].as_str().unwrap_or(id).into(),
            access: profile_access(&root.join(id), &bookmarks),
            bookmarks,
            format: BookmarkFormat::Chromium,
        });
    }
    profiles.sort_by(|a, b| a.id.cmp(&b.id));
    profiles
}

fn profile_access(dir: &Path, file: &Path) -> ProfileAccess {
    if probe(dir) == ProfileAccess::PermissionDenied
        || probe(file) == ProfileAccess::PermissionDenied
    {
        ProfileAccess::PermissionDenied
    } else {
        ProfileAccess::Ready
    }
}

fn safe_relative(value: &str) -> bool {
    !value.is_empty()
        && Path::new(value)
            .components()
            .all(|p| matches!(p, std::path::Component::Normal(_)))
}

fn firefox_profiles(browser: &'static str, root: &Path) -> Vec<BrowserProfile> {
    let base = if root.file_name().is_some_and(|n| n == "Profiles") {
        root.parent().unwrap_or(root)
    } else {
        root
    };
    let ini = base.join("profiles.ini");
    if probe(&ini) == ProfileAccess::PermissionDenied
        || probe(base) == ProfileAccess::PermissionDenied
    {
        return vec![blocked(browser, base, BookmarkFormat::Firefox)];
    }
    let Ok(text) = std::fs::read_to_string(&ini) else {
        return Vec::new();
    };
    let mut profiles = Vec::new();
    for section in text.split('[').filter(|s| s.starts_with("Profile")) {
        let values: std::collections::HashMap<_, _> = section
            .lines()
            .filter_map(|line| line.split_once('='))
            .map(|(k, v)| (k.trim(), v.trim()))
            .collect();
        let Some(path) = values.get("Path") else {
            continue;
        };
        let dir = if values.get("IsRelative") == Some(&"0") {
            PathBuf::from(path)
        } else {
            if !safe_relative(path) {
                continue;
            }
            base.join(path)
        };
        let id = dir
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let bookmarks = dir.join("places.sqlite");
        profiles.push(BrowserProfile {
            browser,
            name: values.get("Name").unwrap_or(&id.as_str()).to_string(),
            id,
            access: profile_access(&dir, &bookmarks),
            bookmarks,
            format: BookmarkFormat::Firefox,
        });
    }
    profiles.sort_by(|a, b| a.id.cmp(&b.id));
    profiles
}

#[cfg(target_os = "macos")]
fn zen_root(home: &Path) -> PathBuf {
    home.join("Library/Application Support/zen/Profiles")
}
#[cfg(windows)]
fn zen_root(home: &Path) -> PathBuf {
    home.join("AppData/Roaming/zen/Profiles")
}
#[cfg(all(unix, not(target_os = "macos")))]
fn zen_root(home: &Path) -> PathBuf {
    home.join(".zen")
}

/// A folder explicitly chosen by the owner is used for this run only.
pub fn from_folder(mut profile: BrowserProfile, folder: &Path) -> io::Result<BrowserProfile> {
    let file = match profile.format {
        BookmarkFormat::Chromium => "Bookmarks",
        BookmarkFormat::Firefox => "places.sqlite",
        BookmarkFormat::Safari => "Bookmarks.plist",
    };
    let mut path = folder.join(file);
    if profile.format == BookmarkFormat::Chromium && !path.is_file() {
        path = folder.join(&profile.id).join(file);
    }
    std::fs::read_dir(path.parent().unwrap_or(folder))?;
    profile.bookmarks = path;
    profile.access = ProfileAccess::Ready;
    Ok(profile)
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

/// Enumerate profiles inside a native-picked browser root, or accept one profile.
pub fn picked_profiles(profile: BrowserProfile, folder: &Path) -> io::Result<Vec<BrowserProfile>> {
    if profile.format == BookmarkFormat::Chromium && folder.join("Local State").is_file() {
        let found = chromium_profiles(profile.browser, folder);
        if !found.is_empty() {
            return Ok(found);
        }
    }
    if profile.format == BookmarkFormat::Firefox && folder.join("profiles.ini").is_file() {
        let found = firefox_profiles(profile.browser, folder);
        if !found.is_empty() {
            return Ok(found);
        }
    }
    from_folder(profile, folder).map(|p| vec![p])
}
