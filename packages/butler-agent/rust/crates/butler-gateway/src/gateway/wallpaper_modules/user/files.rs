//! A module's files as read: size limits without following links, the
//! default image's type by content, and the revision hash over all of them.

use std::{
    fmt::Write as _,
    fs::{self, File},
    io::{self, Read},
    path::Path,
};

use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{
    MANIFEST, MAX_IMAGE_BYTES, MAX_MANIFEST_BYTES, MAX_OVERLAY_BYTES, MAX_SHADER_BYTES, OVERLAY,
    SHADER,
};
use crate::gateway::wallpaper_modules::is_image_file;

pub(crate) const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

/// A module file as read: its bytes, or why there are none.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) enum FileRead {
    #[default]
    Missing,
    NotFile,
    TooLarge(usize),
    Bytes(Vec<u8>),
}

impl FileRead {
    /// `bytes`, or too large past `limit`.
    pub(crate) fn within(bytes: Vec<u8>, limit: usize) -> Self {
        if bytes.len() > limit {
            Self::TooLarge(limit)
        } else {
            Self::Bytes(bytes)
        }
    }

    fn content(&self) -> Option<&[u8]> {
        match self {
            Self::Bytes(bytes) => Some(bytes),
            _ => None,
        }
    }
}

/// Every file a module may have, as read. `image` is the file the manifest's
/// `defaultImage` names, with that name; none when it names none.
#[derive(Debug, Default)]
pub(crate) struct ModuleFiles {
    pub(crate) manifest: FileRead,
    pub(crate) shader: FileRead,
    pub(crate) overlay: FileRead,
    pub(crate) image: Option<(String, FileRead)>,
}

impl ModuleFiles {
    /// The files of module folder `folder` (not a link).
    pub(crate) fn read(folder: &Path) -> io::Result<Self> {
        let manifest = limited(&folder.join(MANIFEST), MAX_MANIFEST_BYTES)?;
        let image = match default_image_name(&manifest) {
            Some(name) => Some((name.clone(), limited(&folder.join(name), MAX_IMAGE_BYTES)?)),
            None => None,
        };
        Ok(Self {
            shader: limited(&folder.join(SHADER), MAX_SHADER_BYTES)?,
            overlay: limited(&folder.join(OVERLAY), MAX_OVERLAY_BYTES)?,
            manifest,
            image,
        })
    }

    /// The manifest's `name`, whatever else it holds.
    pub(crate) fn name(&self) -> Option<Value> {
        let manifest = serde_json::from_slice::<Value>(self.manifest.content()?).ok()?;
        manifest.get("name").cloned()
    }

    /// 32 hex digits of SHA-256 over the files. The overlay and the image are
    /// hashed only when present, so a module without them keeps the revision
    /// it had before they existed.
    pub(crate) fn revision(&self) -> String {
        let manifest = self.manifest.content().unwrap_or_default();
        let mut hash = Sha256::new();
        hash.update((manifest.len() as u64).to_le_bytes());
        hash.update(manifest);
        hash.update(self.shader.content().unwrap_or_default());
        let image = self.image.as_ref();
        let extras = [
            (OVERLAY, self.overlay.content()),
            (
                image.map_or("", |(name, _)| name.as_str()),
                image.and_then(|(_, read)| read.content()),
            ),
        ];
        for (name, content) in extras {
            if let Some(content) = content {
                hash.update(b"\0");
                hash.update(name.as_bytes());
                hash.update((content.len() as u64).to_le_bytes());
                hash.update(content);
            }
        }
        hash.finalize()[..16]
            .iter()
            .fold(String::with_capacity(32), |mut hex, byte| {
                let _ = write!(hex, "{byte:02x}");
                hex
            })
    }
}

/// The image file the manifest names, when the name is a valid one.
pub(crate) fn default_image_name(manifest: &FileRead) -> Option<String> {
    let manifest = serde_json::from_slice::<Value>(manifest.content()?).ok()?;
    let name = manifest.get("defaultImage")?.as_str()?;
    is_image_file(name).then(|| name.to_owned())
}

/// A module's default image: its file name, media type and bytes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ModuleImage {
    pub(crate) file: String,
    pub(crate) mime_type: &'static str,
    pub(crate) bytes: Vec<u8>,
}

/// The media type of JPEG, PNG or WebP bytes, by content.
pub(crate) fn image_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(PNG_SIGNATURE) {
        Some("image/png")
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

/// A regular file of at most `limit` bytes; links are not followed.
pub(crate) fn limited(path: &Path, limit: usize) -> io::Result<FileRead> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(FileRead::Missing),
        Err(error) => return Err(error),
    };
    if !meta.is_file() {
        return Ok(FileRead::NotFile);
    }
    let mut bytes = Vec::new();
    File::open(path)?
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)?;
    Ok(FileRead::within(bytes, limit))
}

/// A byte limit as `N MB` for whole megabytes, else `N KB`.
pub(crate) fn size(limit: usize) -> String {
    const MB: usize = 1024 * 1024;
    if limit.is_multiple_of(MB) {
        format!("{} MB", limit / MB)
    } else {
        format!("{} KB", limit / 1024)
    }
}
