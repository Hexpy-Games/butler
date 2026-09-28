use rusqlite::Connection;

use super::super::AppStorageError;

/// Wallpaper asset metadata (the files live under `app-server/wallpapers`)
/// and the App's last check of each user module, keyed by the revision of
/// the module files it checked.
pub(super) fn create(connection: &Connection) -> Result<(), AppStorageError> {
    connection
        .execute_batch(WALLPAPER_SCHEMA)
        .map_err(AppStorageError::sqlite)
}

const WALLPAPER_SCHEMA: &str = r"
CREATE TABLE IF NOT EXISTS app_wallpaper_assets (
  id TEXT PRIMARY KEY,
  mime_type TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL,
  thumbnail_mime_type TEXT NOT NULL,
  luminance REAL NOT NULL,
  color TEXT NOT NULL,
  source_message_file_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS app_wallpaper_module_status (
  id TEXT PRIMARY KEY,
  revision TEXT NOT NULL,
  state TEXT NOT NULL,
  message TEXT,
  checked_at TEXT NOT NULL
);
";
