//! Module archives (`POST /wallpaper-modules/import`) and module folder
//! installation and removal.
//!
//! An archive is a zip of at most 2 MB holding `wallpaper.json`,
//! `shader.frag` and optionally `overlay.frag`, the image the manifest's
//! `defaultImage` names (at most 1 MB) and `thumbnail.png`, at its top or
//! inside one folder. Entries that could escape the module folder (`..`,
//! absolute paths, symbolic links), executables and any other file are
//! refused by name; Finder metadata (`__MACOSX/`, `.DS_Store`) is skipped.
//! Nothing is written until the whole archive passes the same checks as a
//! module folder, and an installed module is replaced only when asked, with
//! its previous copy kept (see [`install`]).

use std::{
    fs,
    io::{self, Cursor, Read, Write},
    path::{Component, Path},
};

use butler_platform::secure_fs::{self, FileMode};
use zip::ZipArchive;

use super::user::{
    self, FileRead, MANIFEST, MAX_IMAGE_BYTES, MAX_MANIFEST_BYTES, MAX_OVERLAY_BYTES,
    MAX_SHADER_BYTES, ModuleFiles, OVERLAY, PNG_SIGNATURE, SHADER, THUMBNAIL, size,
};
use super::{WallpaperModule, is_image_file};
use crate::gateway::GatewayApplicationError;

pub(crate) const MAX_ARCHIVE_BYTES: usize = 2 * 1024 * 1024;
const MAX_ENTRIES: usize = 64;
const MAX_THUMBNAIL_BYTES: usize = 512 * 1024;
/// Where the last replaced copy of each module is kept: `<root>/.previous/<id>`.
const PREVIOUS: &str = ".previous";
const LAYOUT: &str = "only wallpaper.json, shader.frag, overlay.frag, thumbnail.png and the \
                      image named by defaultImage are allowed, at the top of the archive or \
                      inside one folder";

/// A checked archive: its module and files, by file name.
pub(crate) struct Unpacked {
    pub(crate) module: WallpaperModule,
    pub(crate) files: Vec<(String, Vec<u8>)>,
}

impl Unpacked {
    /// The revision these files have once installed.
    pub(crate) fn revision(&self) -> String {
        let read = |name: &str| {
            self.files
                .iter()
                .find(|(file, _)| file == name)
                .map_or(FileRead::Missing, |(_, bytes)| {
                    FileRead::Bytes(bytes.clone())
                })
        };
        ModuleFiles {
            manifest: read(MANIFEST),
            shader: read(SHADER),
            overlay: read(OVERLAY),
            image: self
                .module
                .default_image
                .as_ref()
                .map(|name| (name.clone(), read(name))),
        }
        .revision()
    }
}

/// Reads and checks a module archive.
pub(crate) fn unpack(archive: &[u8]) -> Result<Unpacked, GatewayApplicationError> {
    if archive.len() > MAX_ARCHIVE_BYTES {
        return Err(GatewayApplicationError::public(
            413,
            "wallpaper_module_archive_too_large",
            "Wallpaper module archive must be 2 MB or smaller.",
        ));
    }
    let not_zip = || invalid("Wallpaper module archive must be a zip file.");
    let mut zip = ZipArchive::new(Cursor::new(archive)).map_err(|_| not_zip())?;
    if zip.len() > MAX_ENTRIES {
        return Err(invalid(&format!(
            "Wallpaper module archive must hold at most {MAX_ENTRIES} entries."
        )));
    }
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    let mut folder: Option<Option<String>> = None;
    for index in 0..zip.len() {
        let mut item = zip.by_index(index).map_err(|_| not_zip())?;
        let name = item.name().to_owned();
        if skipped(&name) {
            continue;
        }
        let Some(parts) = item.enclosed_name().as_deref().and_then(normal_parts) else {
            return Err(entry(&name, "its path leaves the archive"));
        };
        if item.is_symlink() {
            return Err(entry(&name, "symbolic links are not allowed"));
        }
        if item.is_dir() {
            if parts.len() > 1 {
                return Err(entry(&name, LAYOUT));
            }
            continue;
        }
        let (prefix, file) = match parts.as_slice() {
            [file] => (None, file.as_str()),
            [prefix, file] => (Some(prefix.clone()), file.as_str()),
            _ => return Err(entry(&name, LAYOUT)),
        };
        if *folder.get_or_insert_with(|| prefix.clone()) != prefix {
            return Err(entry(&name, LAYOUT));
        }
        let limit = match file {
            MANIFEST => MAX_MANIFEST_BYTES,
            SHADER => MAX_SHADER_BYTES,
            OVERLAY => MAX_OVERLAY_BYTES,
            THUMBNAIL => MAX_THUMBNAIL_BYTES,
            image if is_image_file(image) => MAX_IMAGE_BYTES,
            _ => return Err(entry(&name, LAYOUT)),
        };
        let file = file.to_owned();
        if item
            .unix_mode()
            .is_some_and(|mode| FileMode::from_bits(mode).is_executable())
        {
            return Err(entry(&name, "executable files are not allowed"));
        }
        if files.iter().any(|(seen, _)| *seen == file) {
            return Err(entry(&name, "appears twice"));
        }
        let mut bytes = Vec::new();
        (&mut item)
            .take(limit as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| not_zip())?;
        if bytes.len() > limit {
            return Err(GatewayApplicationError::public(
                413,
                "wallpaper_module_file_too_large",
                format!("{file} must be at most {}.", size(limit)),
            ));
        }
        files.push((file, bytes));
    }
    let module = checked(&files)?;
    Ok(Unpacked { module, files })
}

/// The archive's module under the folder checks; every image in it but the
/// thumbnail must be the one `defaultImage` names.
fn checked(files: &[(String, Vec<u8>)]) -> Result<WallpaperModule, GatewayApplicationError> {
    let file = |name: &str| files.iter().find(|(file, _)| file == name);
    for required in [MANIFEST, SHADER] {
        if file(required).is_none() {
            return Err(invalid(&format!("{required} is missing from the archive.")));
        }
    }
    if file(THUMBNAIL).is_some_and(|(_, bytes)| !bytes.starts_with(PNG_SIGNATURE)) {
        return Err(entry(THUMBNAIL, "must be a PNG image"));
    }
    let read = |name: &str| {
        file(name).map_or(FileRead::Missing, |(_, bytes)| {
            FileRead::Bytes(bytes.clone())
        })
    };
    let manifest = read(MANIFEST);
    let image = user::default_image_name(&manifest);
    if let Some((stray, _)) = files
        .iter()
        .find(|(name, _)| is_image_file(name) && name != THUMBNAIL && Some(name) != image.as_ref())
    {
        return Err(entry(stray, LAYOUT));
    }
    let files = ModuleFiles {
        manifest,
        shader: read(SHADER),
        overlay: read(OVERLAY),
        image: image.map(|name| {
            let bytes = read(&name);
            (name, bytes)
        }),
    };
    user::check(None, &files)
        .map(|(module, _)| module)
        .map_err(|errors| {
            GatewayApplicationError::public(
                400,
                "wallpaper_module_invalid",
                format!("The wallpaper module is invalid: {}.", errors.join("; ")),
            )
        })
}

/// Writes the module to `<root>/<id>/` through a `.import-<unique>` folder.
/// An installed copy is replaced only with `replace` (409
/// `wallpaper_module_exists` otherwise): its `thumbnail.png` carries over
/// when the new files bring none, and the replaced folder is kept as
/// `<root>/.previous/<id>/`, one copy per module, so it can be restored.
pub(crate) fn install(
    root: &Path,
    unpacked: &Unpacked,
    unique: &str,
    replace: bool,
) -> Result<(), GatewayApplicationError> {
    let id = &unpacked.module.id;
    let target = root.join(id);
    let installed = match fs::symlink_metadata(&target) {
        Ok(_) => true,
        Err(error) if error.kind() == io::ErrorKind::NotFound => false,
        Err(error) => return Err(GatewayApplicationError::internal_from(error)),
    };
    if installed && !replace {
        return Err(GatewayApplicationError::public(
            409,
            "wallpaper_module_exists",
            format!(
                "Wallpaper module {id} is already installed. Import it with replace to overwrite it."
            ),
        ));
    }
    let staging = root.join(format!(".import-{unique}"));
    let written = secure_fs::create_private_dir_all(&staging)
        .and_then(|()| {
            unpacked
                .files
                .iter()
                .try_for_each(|(name, bytes)| write_private(&staging.join(name), bytes))
        })
        .and_then(|()| keep_thumbnail(&target, &staging, unpacked))
        .and_then(|()| secure_fs::sync_directory(&staging).unwrap_or(Ok(())))
        .and_then(|()| swap_in(root, id, &staging, unique));
    if written.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    written.map_err(GatewayApplicationError::internal_from)
}

/// Removes the module folder `id`; false when there is none.
pub(crate) fn remove(root: &Path, id: &str, unique: &str) -> Result<bool, GatewayApplicationError> {
    if !user::is_folder_name(id) {
        return Ok(false);
    }
    let trash = root.join(format!(".removed-{unique}"));
    match fs::rename(root.join(id), &trash) {
        Ok(()) => discard(&trash)
            .map(|()| true)
            .map_err(GatewayApplicationError::internal_from),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(GatewayApplicationError::internal_from(error)),
    }
}

/// Recovers interrupted replacements before deleting abandoned staging. The
/// manifest supplies the id even for legacy `.trash-<unique>` names.
/// Caller holds the module write lock.
pub(crate) fn sweep(root: &Path) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(".removed-") || name.starts_with(".import-") {
            let _ = discard(&entry.path());
        } else if name.starts_with(".trash-") {
            recover_copy(root, &entry.path());
        }
    }
}

fn recover_copy(root: &Path, path: &Path) {
    let id = user::limited(&path.join(MANIFEST), MAX_MANIFEST_BYTES)
        .ok()
        .and_then(|read| match read {
            FileRead::Bytes(bytes) => serde_json::from_slice::<serde_json::Value>(&bytes).ok(),
            _ => None,
        })
        .and_then(|manifest| {
            manifest
                .get("id")
                .and_then(|id| id.as_str())
                .map(str::to_owned)
        })
        .filter(|id| user::is_folder_name(id));
    let Some(id) = id else {
        return;
    };
    match fs::symlink_metadata(root.join(&id)) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let _ = secure_fs::rename(path, &root.join(&id));
        }
        Ok(_) => {
            // An orphan has no ordering journal. Never replace an existing
            // previous copy with a potentially older abandoned transaction.
            if root.join(PREVIOUS).join(&id).exists() {
                let _ = discard(path);
            } else {
                let _ = keep_previous(root, &id, path);
            }
        }
        Err(_) => {}
    }
}

/// `bytes` as a new file only the owner can read, where the host has modes.
fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    let _ = secure_fs::owner_only(&mut options);
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

/// Copies the installed module's `thumbnail.png` into `staging` when the new
/// files bring none.
fn keep_thumbnail(target: &Path, staging: &Path, unpacked: &Unpacked) -> io::Result<()> {
    if unpacked.files.iter().any(|(name, _)| name == THUMBNAIL)
        || !fs::symlink_metadata(target).is_ok_and(|meta| meta.is_dir())
    {
        return Ok(());
    }
    match user::limited(&target.join(THUMBNAIL), MAX_THUMBNAIL_BYTES)? {
        FileRead::Bytes(bytes) if bytes.starts_with(PNG_SIGNATURE) => {
            write_private(&staging.join(THUMBNAIL), &bytes)
        }
        _ => Ok(()),
    }
}

/// Exchanges complete trees where supported. The fallback leaves a recoverable
/// `.trash-*` journal between renames and rolls back ordinary I/O failures.
fn swap_in(root: &Path, id: &str, staging: &Path, unique: &str) -> io::Result<()> {
    let target = root.join(id);
    if !target.exists() {
        secure_fs::rename(staging, &target)?;
        return secure_fs::sync_directory(root).unwrap_or(Ok(()));
    }
    let aside = root.join(format!(".trash-{unique}"));
    let old = match secure_fs::exchange_directories(staging, &target) {
        Ok(()) => {
            // Give the exchanged old tree a recovery name before retention.
            // If this rename fails the current tree is still complete.
            if secure_fs::rename(staging, &aside).is_err() {
                return Ok(());
            }
            &aside
        }
        Err(secure_fs::ExchangeError::Unsupported) => {
            secure_fs::rename(&target, &aside)?;
            if let Err(error) = secure_fs::sync_directory(root)
                .unwrap_or(Ok(()))
                .and_then(|()| secure_fs::rename(staging, &target))
            {
                let _ = secure_fs::rename(&aside, &target);
                return Err(error);
            }
            &aside
        }
        Err(error) => return Err(io::Error::other(error)),
    };
    // Publication succeeded. A failed retention leaves the complete old copy
    // for sweep, rather than deleting the only recoverable previous version.
    let _ = secure_fs::sync_directory(root).unwrap_or(Ok(()));
    let _ = keep_previous(root, id, old);
    Ok(())
}

/// Publishes the new previous copy before discarding the older previous copy.
fn keep_previous(root: &Path, id: &str, aside: &Path) -> io::Result<()> {
    let previous = root.join(PREVIOUS);
    secure_fs::create_private_dir_all(&previous)?;
    let kept = previous.join(id);
    secure_fs::fault_checkpoint("wallpaper_previous")?;
    if !kept.exists() {
        secure_fs::rename(aside, &kept)?;
        return sync_retention(root, &previous);
    }
    match secure_fs::exchange_directories(aside, &kept) {
        Ok(()) => {
            sync_retention(root, &previous)?;
            discard(aside)
        }
        Err(secure_fs::ExchangeError::Unsupported) => {
            let retired = previous.join(format!(".retired-{id}"));
            if retired.exists() {
                sync_retention(root, &previous)?;
                discard(&retired)?;
            }
            secure_fs::rename(&kept, &retired)?;
            if let Err(error) = secure_fs::rename(aside, &kept) {
                let _ = secure_fs::rename(&retired, &kept);
                return Err(error);
            }
            sync_retention(root, &previous)?;
            discard(&retired)
        }
        Err(error) => Err(io::Error::other(error)),
    }
}

fn sync_retention(root: &Path, previous: &Path) -> io::Result<()> {
    secure_fs::sync_directory(root).unwrap_or(Ok(()))?;
    secure_fs::sync_directory(previous).unwrap_or(Ok(()))
}

/// Deletes a folder, or the link or file in its place, without following it.
fn discard(path: &Path) -> io::Result<()> {
    if fs::symlink_metadata(path)?.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}

/// Finder metadata, which zips made on macOS carry.
fn skipped(name: &str) -> bool {
    name.starts_with("__MACOSX/") || name.rsplit('/').next() == Some(".DS_Store")
}

/// The path's parts when every one is a plain name.
fn normal_parts(path: &Path) -> Option<Vec<String>> {
    path.components()
        .map(|component| match component {
            Component::Normal(part) => part.to_str().map(str::to_owned),
            _ => None,
        })
        .collect()
}

fn entry(name: &str, rule: &str) -> GatewayApplicationError {
    invalid(&format!("Archive entry {name}: {rule}."))
}

fn invalid(message: &str) -> GatewayApplicationError {
    GatewayApplicationError::public(400, "wallpaper_module_archive_invalid", message)
}
