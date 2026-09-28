//! Asset files: `<id>.<ext>` and `<id>.thumb.<ext>`, owner-only, written
//! through a temporary sibling and renamed so a reader never sees half a
//! file.

use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
};

use butler_platform::secure_fs;

use bytes::Bytes;

use super::pipeline::ProcessedWallpaper;
use crate::gateway::{
    AppWallpaperVariant, GatewayApplicationError,
    wallpapers::{is_asset_id, not_found},
};

pub(super) fn write(
    root: &Path,
    id: &str,
    processed: &ProcessedWallpaper,
) -> Result<(), GatewayApplicationError> {
    let image = path(
        root,
        id,
        processed.image.mime_type,
        AppWallpaperVariant::Image,
    )?;
    let thumbnail = path(
        root,
        id,
        processed.thumbnail.mime_type,
        AppWallpaperVariant::Thumbnail,
    )?;
    secure_fs::create_private_dir_all(root).map_err(GatewayApplicationError::internal_from)?;
    let written = write_atomic(&image, &processed.image.bytes)
        .and_then(|()| write_atomic(&thumbnail, &processed.thumbnail.bytes));
    if written.is_err() {
        let _ = fs::remove_file(&image);
        let _ = fs::remove_file(&thumbnail);
    }
    written.map_err(GatewayApplicationError::internal_from)
}

pub(super) fn read(
    root: &Path,
    id: &str,
    mime_type: &str,
    variant: AppWallpaperVariant,
) -> Result<Bytes, GatewayApplicationError> {
    fs::read(path(root, id, mime_type, variant)?)
        .map(Bytes::from)
        .map_err(|error| match error.kind() {
            io::ErrorKind::NotFound => not_found(),
            _ => GatewayApplicationError::internal_from(error),
        })
}

/// Removes both files; files that are already gone count as removed.
pub(super) fn remove(
    root: &Path,
    id: &str,
    mime_type: &str,
    thumbnail_mime_type: &str,
) -> Result<(), GatewayApplicationError> {
    for path in [
        path(root, id, mime_type, AppWallpaperVariant::Image)?,
        path(
            root,
            id,
            thumbnail_mime_type,
            AppWallpaperVariant::Thumbnail,
        )?,
    ] {
        match fs::remove_file(path) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => {
                return Err(GatewayApplicationError::internal_from(error));
            }
            _ => {}
        }
    }
    Ok(())
}

/// Writes `bytes` to `path` through an owner-only temporary file.
fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    secure_fs::replace_private(path, |file| file.write_all(bytes), |error| error)
}

/// The file of `id`; an id outside the asset pattern names no file.
fn path(
    root: &Path,
    id: &str,
    mime_type: &str,
    variant: AppWallpaperVariant,
) -> Result<PathBuf, GatewayApplicationError> {
    if !is_asset_id(id) {
        return Err(not_found());
    }
    let extension = match mime_type {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        _ => return Err(GatewayApplicationError::internal()),
    };
    let suffix = match variant {
        AppWallpaperVariant::Image => "",
        AppWallpaperVariant::Thumbnail => ".thumb",
    };
    Ok(root.join(format!("{id}{suffix}.{extension}")))
}
