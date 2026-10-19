//! User-facing folders are not application data roots, even when configured as DATA.
use std::path::PathBuf;
#[cfg(all(unix, not(target_os = "macos")))]
use std::{env, fs};

pub(super) fn folders() -> Vec<PathBuf> {
    let Some(home) = super::non_empty_home_dir() else {
        return Vec::new();
    };
    let mut folders = [
        "Desktop",
        "Documents",
        "Downloads",
        "Pictures",
        "Music",
        "Movies",
        "Videos",
        "Public",
    ]
    .map(|name| home.join(name))
    .to_vec();
    folders.push(home.clone());
    platform_folders(&home, &mut folders);
    folders
}

#[cfg(all(unix, not(target_os = "macos")))]
fn platform_folders(home: &std::path::Path, folders: &mut Vec<PathBuf>) {
    let config = env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| home.join(".config"));
    let Ok(text) = fs::read_to_string(config.join("user-dirs.dirs")) else {
        return;
    };
    for line in text.lines() {
        let Some((key, value)) = line.trim().split_once('=') else {
            continue;
        };
        if ![
            "XDG_DESKTOP_DIR",
            "XDG_DOCUMENTS_DIR",
            "XDG_DOWNLOAD_DIR",
            "XDG_PICTURES_DIR",
            "XDG_MUSIC_DIR",
            "XDG_VIDEOS_DIR",
            "XDG_PUBLICSHARE_DIR",
        ]
        .contains(&key)
        {
            continue;
        }
        let value = value.trim().trim_matches('"');
        let path = if let Some(suffix) = value.strip_prefix("$HOME/") {
            home.join(suffix)
        } else {
            PathBuf::from(value)
        };
        if path.is_absolute() {
            folders.push(path);
        }
    }
}

#[cfg(target_os = "macos")]
fn platform_folders(_: &std::path::Path, _: &mut Vec<PathBuf>) {}

#[cfg(windows)]
fn platform_folders(_: &std::path::Path, folders: &mut Vec<PathBuf>) {
    use winsafe::{SHGetKnownFolderPath, co};
    for id in [
        co::KNOWNFOLDERID::Desktop,
        co::KNOWNFOLDERID::Documents,
        co::KNOWNFOLDERID::Downloads,
        co::KNOWNFOLDERID::Pictures,
        co::KNOWNFOLDERID::Music,
        co::KNOWNFOLDERID::Videos,
        co::KNOWNFOLDERID::Public,
    ] {
        if let Ok(path) = SHGetKnownFolderPath(&id, co::KF::DEFAULT, None) {
            folders.push(PathBuf::from(path));
        }
    }
}
