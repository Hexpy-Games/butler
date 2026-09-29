//! User modules: `<BUTLER_HOME>/wallpapers/<id>/` holding `wallpaper.json`,
//! `shader.frag`, and optionally `overlay.frag` (with `"overlay": true`), the
//! image the manifest's `defaultImage` names (JPEG, PNG or WebP, at most
//! 1 MB, at most 4096 px per side and 16 MP) and
//! `thumbnail.png`. Folders are read fresh on every use, so a
//! listing always shows the files as they are now.
//!
//! Every folder is listed under its name. One whose files break the contract
//! is listed with the reasons (`field: rule; ...`) so its author can fix it,
//! and is never selectable. A status the App reported (compile, link or frame
//! budget) belongs to one revision, a hash of the module's files, so it
//! lapses to `unknown` as soon as any of them changes. Names starting with
//! `.` (import staging) are not modules.

mod files;

use std::{fs, io, path::Path};

use serde_json::{Map, Value, json};

pub(crate) use files::{
    FileRead, ModuleFiles, ModuleImage, PNG_SIGNATURE, default_image_name, limited, size,
};
use files::{image_dimensions_rule, image_type};

use super::{
    ENGINE_IMAGE_MODULE, WallpaperModules, is_image_file,
    manifest::{self, WallpaperModule},
};

pub(crate) const MANIFEST: &str = "wallpaper.json";
pub(crate) const SHADER: &str = "shader.frag";
pub(crate) const OVERLAY: &str = "overlay.frag";
pub(crate) const THUMBNAIL: &str = "thumbnail.png";
pub(crate) const MAX_MANIFEST_BYTES: usize = 32 * 1024;
pub(crate) const MAX_SHADER_BYTES: usize = 64 * 1024;
pub(crate) const MAX_OVERLAY_BYTES: usize = 64 * 1024;
pub(crate) const MAX_IMAGE_BYTES: usize = 1024 * 1024;

/// One folder of the user module directory, as its files are now.
#[derive(Clone, Debug)]
pub(crate) struct UserModule {
    /// The folder name, which a valid module's id equals.
    pub(crate) id: String,
    /// Hash of the module's files; changes with any of them.
    pub(crate) revision: String,
    /// The module, or why it cannot be used (`field: rule; ...`).
    pub(crate) module: Result<WallpaperModule, String>,
    /// The files of a valid module.
    checked: Option<CheckedFiles>,
    /// The manifest's `name`, when it is a valid label.
    name: Option<Value>,
}

/// The drawable files of a module that passed the checks.
#[derive(Clone, Debug)]
pub(crate) struct CheckedFiles {
    pub(crate) shader: String,
    pub(crate) overlay: Option<String>,
    pub(crate) image: Option<ModuleImage>,
}

/// A status the App reported for one revision of a module.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ModuleStatus {
    pub(crate) revision: String,
    /// `checking` (the App is about to compile and draw it), `ok` or
    /// `error`.
    pub(crate) state: String,
    pub(crate) message: Option<String>,
    pub(crate) checked_at: String,
}

impl UserModule {
    pub(crate) fn shader(&self) -> Option<&str> {
        self.checked.as_ref().map(|files| files.shader.as_str())
    }

    pub(crate) fn overlay(&self) -> Option<&str> {
        self.checked.as_ref()?.overlay.as_deref()
    }

    pub(crate) fn image(&self) -> Option<&ModuleImage> {
        self.checked.as_ref()?.image.as_ref()
    }

    /// `{state, message?, checkedAt?}`: a contract error, the report of the
    /// current revision, or `unknown` until the App checks these files.
    pub(crate) fn status(&self, stored: Option<&ModuleStatus>) -> Value {
        match (&self.module, stored) {
            (Err(message), _) => json!({"state": "error", "message": message}),
            (Ok(_), Some(stored)) if stored.revision == self.revision => {
                let mut status = Map::new();
                status.insert("state".into(), json!(stored.state));
                if let Some(message) = &stored.message {
                    status.insert("message".into(), json!(message));
                }
                status.insert("checkedAt".into(), json!(stored.checked_at));
                Value::Object(status)
            }
            _ => json!({"state": "unknown"}),
        }
    }

    /// Why the module cannot be drawn now, if it cannot.
    pub(crate) fn failure(&self, stored: Option<&ModuleStatus>) -> Option<String> {
        match (&self.module, stored) {
            (Err(message), _) => Some(message.clone()),
            (Ok(_), Some(stored))
                if stored.revision == self.revision && stored.state == "error" =>
            {
                Some(
                    stored
                        .message
                        .clone()
                        .unwrap_or_else(|| "the App could not draw it".into()),
                )
            }
            _ => None,
        }
    }

    /// The listing entry: the manifest as authored (for a failing one, its
    /// id and a name) with `source: "user"`, the revision of its files (what
    /// a save that replaces it names) and the status.
    pub(crate) fn entry(&self, stored: Option<&ModuleStatus>) -> Value {
        let mut entry = match &self.module {
            Ok(module) => module.manifest.as_object().cloned().unwrap_or_default(),
            Err(_) => {
                let name = self
                    .name
                    .clone()
                    .unwrap_or_else(|| json!({"en": self.id, "ko": self.id}));
                Map::from_iter([("id".into(), json!(self.id)), ("name".into(), name)])
            }
        };
        entry.insert("source".into(), json!("user"));
        entry.insert("revision".into(), json!(self.revision));
        entry.insert("status".into(), self.status(stored));
        Value::Object(entry)
    }
}

/// Every module folder under `root`, by name; no folder is no modules.
pub(crate) fn scan(root: &Path) -> io::Result<Vec<UserModule>> {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut modules = Vec::new();
    for entry in entries {
        let entry = entry?;
        let kind = entry.file_type()?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if is_folder_name(&name) && (kind.is_dir() || kind.is_symlink()) {
            modules.push(load(&entry.path(), name)?);
        }
    }
    modules.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(modules)
}

/// The module folder `id`, if there is one.
pub(crate) fn read(root: &Path, id: &str) -> io::Result<Option<UserModule>> {
    if !is_folder_name(id) {
        return Ok(None);
    }
    let folder = root.join(id);
    match fs::symlink_metadata(&folder) {
        Ok(meta) if meta.is_dir() || meta.file_type().is_symlink() => {
            load(&folder, id.to_owned()).map(Some)
        }
        Ok(_) => Ok(None),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

/// A name that can only be one folder directly under the module root.
pub(crate) fn is_folder_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 255
        && !name.starts_with('.')
        && !name.contains(['/', '\\', '\0'])
}

/// The contract checks on a module's files, shared by folders, imports and
/// saves: sizes, text, the manifest, the id rules (`folder`, when given, is
/// the folder the id must name), the overlay and the default image. Every
/// error is reported.
pub(crate) fn check(
    folder: Option<&str>,
    files: &ModuleFiles,
) -> Result<(WallpaperModule, CheckedFiles), Vec<String>> {
    let mut errors = Vec::new();
    let manifest = bytes(MANIFEST, &files.manifest, &mut errors);
    let shader = text(SHADER, &files.shader, &mut errors);
    let module = manifest.and_then(|bytes| {
        let text = std::str::from_utf8(bytes)
            .map_err(|_| vec![format!("{MANIFEST}: must be UTF-8 text")])
            .and_then(manifest::parse);
        text.map_err(|found| errors.extend(found)).ok()
    });
    let mut overlay = None;
    let mut image = None;
    if let Some(module) = &module {
        errors.extend(id_errors(&module.id, folder));
        overlay = overlay_text(module, &files.overlay, &mut errors);
        image = module
            .default_image
            .as_deref()
            .and_then(|name| default_image(name, files.image.as_ref(), &mut errors));
    }
    match (module, shader) {
        (Some(module), Some(shader)) if errors.is_empty() => Ok((
            module,
            CheckedFiles {
                shader,
                overlay,
                image,
            },
        )),
        _ => Err(errors),
    }
}

fn bytes<'a>(file: &str, read: &'a FileRead, errors: &mut Vec<String>) -> Option<&'a [u8]> {
    let error = match read {
        FileRead::Bytes(bytes) => return Some(bytes),
        FileRead::Missing => format!("{file}: missing"),
        FileRead::NotFile => format!("{file}: must be a file, not a link"),
        FileRead::TooLarge(limit) => format!("{file}: must be at most {}", size(*limit)),
    };
    errors.push(error);
    None
}

fn text(file: &str, read: &FileRead, errors: &mut Vec<String>) -> Option<String> {
    let text = String::from_utf8(bytes(file, read, errors)?.to_vec()).ok();
    if text.is_none() {
        errors.push(format!("{file}: must be UTF-8 text"));
    }
    text
}

/// `overlay.frag`: required with `"overlay": true`, refused without it.
fn overlay_text(
    module: &WallpaperModule,
    read: &FileRead,
    errors: &mut Vec<String>,
) -> Option<String> {
    match (module.overlay, read) {
        (true, FileRead::Missing) => {
            errors.push(format!("{OVERLAY}: required by overlay: true"));
            None
        }
        (true, read) => text(OVERLAY, read, errors),
        (false, FileRead::Missing) => None,
        (false, _) => {
            errors.push(format!("{OVERLAY}: set overlay: true in {MANIFEST}"));
            None
        }
    }
}

/// The image `name` the manifest's `defaultImage` names, from `read` (the
/// file read under that name).
fn default_image(
    name: &str,
    read: Option<&(String, FileRead)>,
    errors: &mut Vec<String>,
) -> Option<ModuleImage> {
    let read = read
        .filter(|(file, _)| file == name)
        .map_or(&FileRead::Missing, |(_, read)| read);
    let rule = match read {
        FileRead::Bytes(bytes) => match image_type(bytes) {
            Some(mime_type) => match image_dimensions_rule(bytes) {
                None => {
                    return Some(ModuleImage {
                        file: name.to_owned(),
                        mime_type,
                        bytes: bytes.clone(),
                    });
                }
                Some(rule) => rule,
            },
            None => "must be a JPEG, PNG or WebP image".to_owned(),
        },
        FileRead::Missing => "is not in the module folder".to_owned(),
        FileRead::NotFile => "must be a file, not a link".to_owned(),
        FileRead::TooLarge(limit) => format!("must be at most {}", size(*limit)),
    };
    errors.push(format!("defaultImage: {name} {rule}"));
    None
}

/// `butler.*` belongs to built-ins, which user modules never shadow.
pub(super) fn id_errors(id: &str, folder: Option<&str>) -> Vec<String> {
    let mut errors = Vec::new();
    if id.starts_with("butler.") {
        errors.push("id: butler.* ids are reserved for built-in modules".to_owned());
    } else if id == ENGINE_IMAGE_MODULE || WallpaperModules::builtin().get(id).is_some() {
        errors.push(format!("id: {id} is a built-in module"));
    }
    if let Some(folder) = folder.filter(|folder| *folder != id) {
        errors.push(format!("id: must name its folder {folder}"));
    }
    errors
}

/// The image `name` of module folder `id` (not a link), as a save that
/// replaces the module keeps it; missing when there is none.
pub(crate) fn existing_image(root: &Path, id: &str, name: &str) -> io::Result<FileRead> {
    if !is_folder_name(id) || !is_image_file(name) {
        return Ok(FileRead::Missing);
    }
    let folder = root.join(id);
    match fs::symlink_metadata(&folder) {
        Ok(meta) if meta.is_dir() => limited(&folder.join(name), MAX_IMAGE_BYTES),
        Ok(_) => Ok(FileRead::Missing),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(FileRead::Missing),
        Err(error) => Err(error),
    }
}

fn load(folder: &Path, id: String) -> io::Result<UserModule> {
    if fs::symlink_metadata(folder)?.file_type().is_symlink() {
        return Ok(UserModule {
            revision: ModuleFiles::default().revision(),
            module: Err("folder: must be a folder, not a link".into()),
            checked: None,
            name: None,
            id,
        });
    }
    let files = ModuleFiles::read(folder)?;
    let name = files.name().filter(|name| manifest::is_label(Some(name)));
    let (module, checked) = match check(Some(&id), &files) {
        Ok((module, checked)) => (Ok(module), Some(checked)),
        Err(errors) => (Err(errors.join("; ")), None),
    };
    Ok(UserModule {
        revision: files.revision(),
        id,
        module,
        checked,
        name,
    })
}
