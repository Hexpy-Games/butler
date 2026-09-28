//! Asset files: `<id>.<ext>` and `<id>.thumb.<ext>`, written through a
//! `.partial` sibling and renamed so a reader never sees half a file.

use std::{
    fs, io,
    path::{Path, PathBuf},
};

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
    fs::create_dir_all(root).map_err(GatewayApplicationError::internal_from)?;
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

fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut partial = path.as_os_str().to_os_string();
    partial.push(".partial");
    let partial = PathBuf::from(partial);
    fs::write(&partial, bytes)
        .and_then(|()| fs::rename(&partial, path))
        .inspect_err(|_| {
            let _ = fs::remove_file(&partial);
        })
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
