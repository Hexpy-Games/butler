//! `app_wallpaper_assets` rows.

use rusqlite::{Connection, OptionalExtension, Row, params};

use super::super::AppStorageError;
use crate::gateway::AppWallpaperAsset;

pub(super) struct AssetRow {
    pub(super) asset: AppWallpaperAsset,
    pub(super) mime_type: String,
    pub(super) thumbnail_mime_type: String,
}

const COLUMNS: &str =
    "id,width,height,luminance,color,size_bytes,created_at,mime_type,thumbnail_mime_type";

pub(super) fn insert(
    db: &Connection,
    row: &AssetRow,
    source_message_file_id: Option<&str>,
) -> Result<(), AppStorageError> {
    let asset = &row.asset;
    db.execute(
        "INSERT INTO app_wallpaper_assets (id,mime_type,width,height,size_bytes,\
         thumbnail_mime_type,luminance,color,source_message_file_id,created_at) \
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        params![
            asset.id,
            row.mime_type,
            asset.width,
            asset.height,
            asset.bytes,
            row.thumbnail_mime_type,
            asset.luminance,
            asset.color,
            source_message_file_id,
            asset.created_at
        ],
    )
    .map(|_| ())
    .map_err(AppStorageError::sqlite)
}

pub(super) fn get(db: &Connection, id: &str) -> Result<Option<AssetRow>, AppStorageError> {
    db.query_row(
        &format!("SELECT {COLUMNS} FROM app_wallpaper_assets WHERE id=?1"),
        [id],
        read,
    )
    .optional()
    .map_err(AppStorageError::sqlite)
}

/// The newest asset promoted from message file `file_id`.
pub(super) fn from_message_file(
    db: &Connection,
    file_id: &str,
) -> Result<Option<AssetRow>, AppStorageError> {
    db.query_row(
        &format!(
            "SELECT {COLUMNS} FROM app_wallpaper_assets WHERE source_message_file_id=?1 \
             ORDER BY created_at DESC, rowid DESC LIMIT 1"
        ),
        [file_id],
        read,
    )
    .optional()
    .map_err(AppStorageError::sqlite)
}

/// Newest first.
pub(super) fn list(db: &Connection) -> Result<Vec<AppWallpaperAsset>, AppStorageError> {
    let mut statement = db
        .prepare(&format!(
            "SELECT {COLUMNS} FROM app_wallpaper_assets ORDER BY created_at DESC, rowid DESC"
        ))
        .map_err(AppStorageError::sqlite)?;
    statement
        .query_map([], read)
        .and_then(|rows| rows.map(|row| row.map(|row| row.asset)).collect())
        .map_err(AppStorageError::sqlite)
}

pub(super) fn delete(db: &Connection, id: &str) -> Result<(), AppStorageError> {
    db.execute("DELETE FROM app_wallpaper_assets WHERE id=?1", [id])
        .map(|_| ())
        .map_err(AppStorageError::sqlite)
}

fn read(row: &Row<'_>) -> rusqlite::Result<AssetRow> {
    Ok(AssetRow {
        asset: AppWallpaperAsset {
            id: row.get(0)?,
            width: row.get(1)?,
            height: row.get(2)?,
            luminance: row.get(3)?,
            color: row.get(4)?,
            bytes: row.get(5)?,
            created_at: row.get(6)?,
        },
        mime_type: row.get(7)?,
        thumbnail_mime_type: row.get(8)?,
    })
}
