//! Modules the agent saves: the request's id, `wallpaper.json` object,
//! shader text and optional overlay text, checked by the same rules as a
//! module folder and turned into the files an install writes. A save cannot
//! add an image: a `defaultImage` must name one the module being replaced
//! already holds, which the save keeps. Every broken rule is named as
//! `field rule`, with `id` (the request's), `manifest`, `manifest.<path>`,
//! `shader` or `overlay`.

use std::fmt::Write as _;

use super::{
    import::Unpacked,
    is_module_id,
    user::{
        self, FileRead, MANIFEST, MAX_MANIFEST_BYTES, MAX_OVERLAY_BYTES, MAX_SHADER_BYTES,
        ModuleFiles, OVERLAY, SHADER,
    },
};
use crate::gateway::{AppWallpaperRejection, wallpapers::AppWallpaperModuleSaveRequest};

const CODE: &str = "wallpaper_module_invalid";
const NO_NEW_IMAGE: &str = "(a save keeps the image of the module it replaces but cannot add one)";

/// The image file the request's manifest names, for the caller to read from
/// the module being replaced.
pub(crate) fn default_image(request: &AppWallpaperModuleSaveRequest) -> Option<String> {
    let name = request.manifest.get("defaultImage")?.as_str()?;
    super::is_image_file(name).then(|| name.to_owned())
}

/// The module and its files, or a rejection naming every broken rule.
/// `image` is the replaced module's file that [`default_image`] names.
pub(crate) fn checked(
    request: &AppWallpaperModuleSaveRequest,
    image: FileRead,
) -> Result<Unpacked, AppWallpaperRejection> {
    let id = request.id.as_str();
    if !is_module_id(id) {
        let rule = "must match ^[a-z0-9]+(\\.[a-z0-9-]+)+$ and be at most 64 chars";
        return Err(rejection(&[("id".into(), rule.into())]));
    }
    let reserved = user::id_errors(id, None);
    if !reserved.is_empty() {
        let rules = reserved
            .iter()
            .map(|error| ("id".into(), format!("is {id}, but {}", rule(error))));
        return Err(rejection(&rules.collect::<Vec<_>>()));
    }
    if !request.manifest.is_object() {
        let rule = "must be a JSON object: the wallpaper.json content";
        return Err(rejection(&[("manifest".into(), rule.into())]));
    }
    let mut manifest = serde_json::to_vec_pretty(&request.manifest).unwrap_or_default();
    manifest.push(b'\n');
    let shader = request.shader.as_bytes().to_vec();
    let overlay = request
        .overlay
        .as_ref()
        .map(|text| text.as_bytes().to_vec());
    let files = ModuleFiles {
        manifest: FileRead::within(manifest.clone(), MAX_MANIFEST_BYTES),
        shader: FileRead::within(shader.clone(), MAX_SHADER_BYTES),
        overlay: overlay.clone().map_or(FileRead::Missing, |bytes| {
            FileRead::within(bytes, MAX_OVERLAY_BYTES)
        }),
        image: default_image(request).map(|name| (name, image)),
    };
    match user::check(Some(id), &files) {
        Ok((module, checked)) => {
            let mut written = vec![(MANIFEST.to_owned(), manifest), (SHADER.to_owned(), shader)];
            written.extend(overlay.map(|bytes| (OVERLAY.to_owned(), bytes)));
            written.extend(checked.image.map(|image| (image.file, image.bytes)));
            Ok(Unpacked {
                module,
                files: written,
            })
        }
        Err(errors) => Err(rejection(
            &errors.iter().map(|error| field(error)).collect::<Vec<_>>(),
        )),
    }
}

/// A folder check's `path: rule` as the request field it concerns.
fn field(error: &str) -> (String, String) {
    let (path, rule) = error.split_once(": ").unwrap_or(("manifest", error));
    let field = match path {
        MANIFEST | "manifest" => "manifest".to_owned(),
        SHADER => "shader".to_owned(),
        OVERLAY => "overlay".to_owned(),
        path => format!("manifest.{path}"),
    };
    if path == "defaultImage" && rule.ends_with("is not in the module folder") {
        return (field, format!("{rule} {NO_NEW_IMAGE}"));
    }
    (field, rule.to_owned())
}

fn rule(error: &str) -> String {
    error
        .split_once(": ")
        .map_or(error, |(_, rule)| rule)
        .to_owned()
}

/// The first field with its rule, then every other `field rule`.
fn rejection(rules: &[(String, String)]) -> AppWallpaperRejection {
    let (field, mut rule) = rules.first().cloned().unwrap_or_default();
    for (other, broken) in rules.iter().skip(1) {
        let _ = write!(rule, "; {other} {broken}");
    }
    AppWallpaperRejection::new(400, CODE, &field, &rule, None)
}
