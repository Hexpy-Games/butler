//! Native browser import: access, private SQLite snapshots, decryption and exports.
mod chromium;
mod der;
mod downloads;
mod firefox;
mod locks;
mod nss;
use crate::browser_profiles::{BookmarkFormat, BrowserProfile, ProfileAccess};
use crate::secrets::SecretText;
#[cfg(feature = "test-support")]
pub use chromium::fixture_storage_absent;
pub use downloads::DownloadWatch;
#[cfg(feature = "test-support")]
pub use locks::fixture_profile_lock;
use std::path::{Path, PathBuf};
use std::time::Duration;
use zeroize::Zeroizing;

#[derive(Clone, Copy, Debug, thiserror::Error)]
/// Typed source failures; messages contain no source data.
pub enum ImportError {
    /// Source operation failure.
    #[error("browser folder access denied")]
    PermissionDenied,
    /// Source operation failure.
    #[error("source not found")]
    NotFound,
    /// Source operation failure.
    #[error("close the source browser and retry")]
    Locked,
    /// Source operation failure.
    #[error("primary password required")]
    PrimaryPassword,
    /// Source operation failure.
    #[error("incorrect primary password")]
    IncorrectPassword,
    /// Source operation failure.
    #[error("export passwords to CSV")]
    CsvRequired,
    /// Source operation failure.
    #[error("unsupported or invalid browser data")]
    Format,
    /// Source operation failure.
    #[error("source is too large")]
    TooLarge,
    /// Source operation failure.
    #[error("source keychain did not answer")]
    Keychain,
}

/// Values are redacted by SecretText and wiped when dropped.
#[derive(Debug)]
pub struct Login {
    /// Login URL.
    pub origin: String,
    /// Decrypted username.
    pub username: SecretText,
    /// Decrypted password.
    pub password: SecretText,
}

/// Translate filesystem failures without exposing paths.
pub fn io_error(e: &std::io::Error) -> ImportError {
    #[cfg(windows)]
    if matches!(e.raw_os_error(), Some(32 | 33)) {
        return ImportError::Locked;
    }
    match e.kind() {
        std::io::ErrorKind::PermissionDenied => ImportError::PermissionDenied,
        std::io::ErrorKind::NotFound => ImportError::NotFound,
        std::io::ErrorKind::WouldBlock => ImportError::Locked,
        _ => ImportError::Format,
    }
}

/// Translate SQLite failures without exposing SQL or values.
pub fn sql_error(e: &rusqlite::Error) -> ImportError {
    match e {
        rusqlite::Error::SqliteFailure(code, _)
            if matches!(
                code.code,
                rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
            ) =>
        {
            ImportError::Locked
        }
        _ => ImportError::Format,
    }
}

/// Read a bounded source into wiped memory.
pub fn read(path: &Path, max: u64) -> Result<Zeroizing<Vec<u8>>, ImportError> {
    use std::io::Read;
    let file = std::fs::File::open(path).map_err(|e| io_error(&e))?;
    let mut bytes = Zeroizing::new(Vec::new());
    file.take(max + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| io_error(&e))?;
    if bytes.len() as u64 > max {
        return Err(ImportError::TooLarge);
    }
    Ok(bytes)
}

/// The private snapshot includes the WAL. Every exit removes the directory.
pub struct Snapshot {
    root: PathBuf,
    /// Snapshot database file.
    pub path: PathBuf,
}
impl Drop for Snapshot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
impl Snapshot {
    /// Copy the database and WAL; clean up on every exit.
    pub fn new(source: &Path, scratch: &Path) -> Result<Self, ImportError> {
        let dir = source.parent().ok_or(ImportError::NotFound)?;
        for lock in [dir.join(".parentlock"), dir.join("parent.lock")] {
            locks::check(&lock)?;
        }
        if std::fs::symlink_metadata(dir.parent().unwrap_or(dir).join("SingletonLock")).is_ok() {
            return Err(ImportError::Locked);
        }
        std::fs::create_dir_all(scratch).map_err(|e| io_error(&e))?;
        let name = source.file_name().ok_or(ImportError::Format)?;
        let snapshot = Self {
            path: scratch.join(name),
            root: scratch.to_path_buf(),
        };
        for attempt in 0..3 {
            match snapshot.copy(source) {
                Ok(()) => return Ok(snapshot),
                Err(ImportError::Locked) if attempt < 2 => {
                    std::thread::sleep(Duration::from_millis(100));
                }
                Err(e) => return Err(e),
            }
        }
        Err(ImportError::Locked)
    }
    fn copy(&self, source: &Path) -> Result<(), ImportError> {
        std::fs::copy(source, &self.path).map_err(|e| io_error(&e))?;
        let mut wal = source.as_os_str().to_os_string();
        wal.push("-wal");
        match std::fs::metadata(&wal) {
            Ok(_) => {
                let mut dest = self.path.as_os_str().to_os_string();
                dest.push("-wal");
                std::fs::copy(wal, dest).map_err(|e| io_error(&e))?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(io_error(&e)),
        }
        Ok(())
    }
}

/// Whether direct decryption is supported on this platform.
pub fn password_mode(profile: &BrowserProfile) -> &'static str {
    match profile.format {
        BookmarkFormat::Firefox => "direct",
        BookmarkFormat::Chromium if cfg!(target_os = "macos") => "direct",
        _ => "csv",
    }
}

/// Decrypt the selected profile; no secrets enter logs.
pub fn passwords(
    profile: &BrowserProfile,
    primary: &SecretText,
    scratch: &Path,
) -> Result<Vec<Login>, ImportError> {
    if profile.access == ProfileAccess::PermissionDenied {
        return Err(ImportError::PermissionDenied);
    }
    let dir = profile.bookmarks.parent().ok_or(ImportError::NotFound)?;
    match profile.format {
        BookmarkFormat::Firefox => firefox::passwords(dir, primary, scratch),
        BookmarkFormat::Chromium => chromium::passwords(profile.browser, dir, scratch),
        BookmarkFormat::Safari => Err(ImportError::CsvRequired),
    }
}

#[cfg(any(target_os = "macos", windows))]
/// Native user folder selection.
pub fn pick_folder() -> Option<PathBuf> {
    #[cfg(feature = "test-support")]
    if let Some(folder) = std::env::var_os("BUTLER_BROWSER_IMPORT_PICKED_FIXTURE") {
        let folder = PathBuf::from(folder);
        if crate::user_dirs::non_empty_home_dir().is_some_and(|home| folder.starts_with(home)) {
            return Some(folder);
        }
    }
    rfd::FileDialog::new().pick_folder()
}
#[cfg(not(any(target_os = "macos", windows)))]
/// Native user folder selection.
pub fn pick_folder() -> Option<PathBuf> {
    None
}

/// Open the source browser password export instructions.
pub fn export_instructions(browser: &str) -> Result<(), ImportError> {
    let url = match browser {
        "safari" => "https://support.apple.com/guide/passwords/export-passwords-mchl125b6d6d/mac",
        "edge" => {
            "https://support.microsoft.com/microsoft-edge/save-or-forget-passwords-in-microsoft-edge-2d4d1c1b-3b4d-12e5-35e0-8bf6d2ba2e65"
        }
        "firefox" | "zen" => "https://support.mozilla.org/kb/export-login-data-firefox",
        "brave" => {
            "https://support.brave.com/hc/en-us/articles/360018185951-How-do-I-use-the-built-in-password-manager"
        }
        _ => "https://support.google.com/chrome/answer/95606",
    };
    let mut command = crate::desktop::open_url(url).ok_or(ImportError::Format)?;
    command.spawn().map_err(|e| io_error(&e))?;
    Ok(())
}

#[cfg(target_os = "macos")]
/// Open Full Disk Access preferences.
pub fn open_disk_access() -> Result<(), ImportError> {
    std::process::Command::new("/usr/bin/open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")
        .spawn()
        .map_err(|e| io_error(&e))?;
    Ok(())
}
#[cfg(not(target_os = "macos"))]
/// Open Full Disk Access preferences.
pub fn open_disk_access() -> Result<(), ImportError> {
    Err(ImportError::Format)
}
