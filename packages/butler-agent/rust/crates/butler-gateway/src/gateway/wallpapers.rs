//! Wallpapers at the gateway: image assets, the module registry listing and
//! the agent's wallpaper route, with their transport values.
//!
//! An asset is an uploaded (or promoted message-file) image, re-encoded with
//! its long edge at most 3840 px, plus a thumbnail and the average luminance
//! and colour the renderer uses for readability. Assets are immutable; the
//! `wallpaper` setting and project preferences reference them by id.
//!
//! Every change of an effective wallpaper appends `wallpaper.changed`
//! `{scope: "global" | "project", projectId?, previous, next, origin: "agent" |
//! "user"}` next to the write's `settings.updated` / `project.updated`;
//! `previous` and `next` are sources (a project's may be `"inherit"`).
//!
//! Modules are listed as `{...manifest, source: "builtin" | "user", status:
//! {state: "unknown" | "checking" | "ok" | "error", message?, checkedAt?}}`,
//! user modules with the `revision` of their files; a user module whose files
//! break the contract is listed as `{id, name, source, revision, status}`
//! with the reason in `status.message`. `checking` is the App's mark before it
//! compiles and first draws a revision: a mark the App finds again after a
//! restart means that check hung, and the App reports it as an error. Changes under the user module folder
//! append `wallpaper.modules.updated {ids}` once per burst. The agent writes
//! user modules through [`GatewayWallpapers::save_wallpaper_module`], which
//! answers with the App's check of the saved files.

use bytes::Bytes;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{ApplicationFuture, GatewayApplicationError};

/// Stored metadata of one wallpaper asset, as the App reads it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppWallpaperAsset {
    /// `wp_` followed by 32 lowercase hex digits.
    pub id: String,
    pub width: u32,
    pub height: u32,
    /// Average relative luminance of the visible pixels, 0 (black) to 1 (white).
    pub luminance: f64,
    /// Average colour of the visible pixels as `#rrggbb`.
    pub color: String,
    /// Size of the stored (re-encoded) image.
    pub bytes: u64,
    pub created_at: String,
}

/// Which stored file of an asset to read.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AppWallpaperVariant {
    Image,
    Thumbnail,
}

/// One stored file of an asset. Its content never changes, so `etag` is stable.
pub struct AppWallpaperFile {
    pub mime_type: String,
    pub etag: String,
    pub bytes: Bytes,
}

/// Which wallpaper a change applies to.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AppWallpaperScope {
    /// The `wallpaper` setting every screen falls back to.
    Global,
    /// One project's `dashboard_preferences_json.wallpaper`.
    Project,
}

/// `POST /internal/wallpaper`: the agent sets a wallpaper. `source` is a
/// wallpaper source, `"inherit"` (projects only), or
/// `{kind: "image_from_attachment", attachment_id, ..image options}`; image
/// options default to `fit: "cover"`, `blur: 0` and a dim from the image's
/// luminance.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AppWallpaperSetRequest {
    pub scope: AppWallpaperScope,
    #[serde(default)]
    pub project_id: Option<String>,
    // Passthrough: checked field by field so a rejection names the field.
    pub source: Value,
}

/// A written wallpaper: what it was and what it is now.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppWallpaperChange {
    pub scope: AppWallpaperScope,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    pub previous: Value,
    pub next: Value,
    /// False when the wallpaper already was `next`; no event is emitted then.
    pub changed: bool,
}

/// A request the caller can correct: the field at fault, the rule it broke
/// (named in `message`) and, when there is a finite set, what `allowed` is.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct AppWallpaperRejection {
    #[serde(skip)]
    pub status: u16,
    pub code: String,
    pub message: String,
    pub field: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allowed: Option<Box<Value>>,
}

impl AppWallpaperRejection {
    /// `wallpaper_invalid`: `field` broke `rule`.
    pub(crate) fn invalid(field: &str, rule: &str, allowed: Option<Value>) -> Self {
        Self::new(400, "wallpaper_invalid", field, rule, allowed)
    }

    pub(crate) fn new(
        status: u16,
        code: &str,
        field: &str,
        rule: &str,
        allowed: Option<Value>,
    ) -> Self {
        let mut message = format!("{field} {rule}.");
        let names: Option<Vec<&str>> = allowed
            .as_ref()
            .and_then(Value::as_array)
            .and_then(|items| items.iter().map(Value::as_str).collect());
        if let Some(names) = names.filter(|names| !names.is_empty()) {
            message.push_str(&format!(" Allowed: {}.", names.join(", ")));
        }
        Self {
            status,
            code: code.to_owned(),
            message,
            field: field.to_owned(),
            allowed: allowed.map(Box::new),
        }
    }
}

/// A user module's fragment shader (or overlay) and the revision of the
/// files it came from (the route's `ETag`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppWallpaperModuleShader {
    pub text: String,
    pub revision: String,
}

/// `POST /wallpaper-modules/{id}/status`: what the App found drawing a user
/// module, `ok` or `error` with its message (compile or link log, frame
/// budget), or `checking` just before it compiles and first draws one.
/// `revision`, when given, must still be the module's current one.
#[derive(Clone, Debug, Deserialize)]
pub struct AppWallpaperModuleStatusReport {
    pub state: String,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub revision: Option<String>,
}

/// `POST /internal/wallpaper-modules`: the agent writes a user module,
/// `<id>/wallpaper.json` (the `manifest` object), `<id>/shader.frag` and, for
/// a manifest with `"overlay": true`, `<id>/overlay.frag`. Replacing an
/// existing module needs `replace_revision`, its current revision as
/// `list_wallpapers` shows it; the replaced files stay recoverable.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AppWallpaperModuleSaveRequest {
    pub id: String,
    // Passthrough: checked field by field so a rejection names the field.
    pub manifest: Value,
    pub shader: String,
    #[serde(default)]
    pub overlay: Option<String>,
    #[serde(default)]
    pub replace_revision: Option<String>,
}

/// A saved user module and the App's check of the saved files:
/// `{state: "ok" | "error", message?, checkedAt}`, or `{state: "unknown",
/// message}` when the App did not check them in time.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct AppWallpaperModuleSaved {
    pub id: String,
    pub status: Value,
}

/// Wallpaper operations of the App gateway.
pub trait GatewayWallpapers: Send + Sync + 'static {
    /// Stores an uploaded image (JPEG, PNG or WebP by content, at most 25 MiB).
    fn upload_wallpaper(&self, _source: Bytes) -> ApplicationFuture<AppWallpaperAsset> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    /// Stores an existing message file through the same pipeline as an upload.
    fn promote_message_file_to_wallpaper(
        &self,
        _file_id: String,
    ) -> ApplicationFuture<AppWallpaperAsset> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    /// Every asset, newest first.
    fn list_wallpapers(&self) -> ApplicationFuture<Vec<AppWallpaperAsset>> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn read_wallpaper(
        &self,
        _id: String,
        _variant: AppWallpaperVariant,
    ) -> ApplicationFuture<AppWallpaperFile> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    /// Deletes an asset no setting references; returns what was deleted.
    fn delete_wallpaper(&self, _id: String) -> ApplicationFuture<AppWallpaperAsset> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    /// Every module's listing entry, built-ins first, in picker order.
    fn wallpaper_modules(&self) -> ApplicationFuture<Vec<Value>> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    /// The shader of a valid user module.
    fn wallpaper_module_shader(&self, _id: String) -> ApplicationFuture<AppWallpaperModuleShader> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    /// The `overlay.frag` of a valid user module with `"overlay": true`.
    fn wallpaper_module_overlay(&self, _id: String) -> ApplicationFuture<AppWallpaperModuleShader> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    /// The default image of a valid user module that names one; `etag` is
    /// the revision of the module's files.
    fn wallpaper_module_image(&self, _id: String) -> ApplicationFuture<AppWallpaperFile> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    /// Records the App's check of a user module's current files; returns the
    /// module's status.
    fn report_wallpaper_module_status(
        &self,
        _id: String,
        _report: AppWallpaperModuleStatusReport,
    ) -> ApplicationFuture<Value> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    /// Installs a module archive (a zip of at most 2 MB); returns its entry.
    /// An archive whose id is installed already is refused (409
    /// `wallpaper_module_exists`) unless `replace` is set.
    fn import_wallpaper_module(&self, _archive: Bytes, _replace: bool) -> ApplicationFuture<Value> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    /// Deletes a user module nothing draws with.
    fn delete_wallpaper_module(&self, _id: String) -> ApplicationFuture<()> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    /// Checks and writes an agent's user module (replacing one with that id
    /// only at its current revision), then waits briefly for the App's check of the written files; a request
    /// breaking a module rule is an `Ok(Err(rejection))` naming the field.
    fn save_wallpaper_module(
        &self,
        _request: AppWallpaperModuleSaveRequest,
    ) -> ApplicationFuture<Result<AppWallpaperModuleSaved, AppWallpaperRejection>> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    /// What an agent needs to choose a wallpaper: the global setting, the
    /// project's value and effective source (when `project_id` is given), the
    /// module manifests and the uploaded images.
    fn wallpaper_overview(&self, _project_id: Option<String>) -> ApplicationFuture<Value> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    /// Validates and writes an agent's wallpaper; a correctable request is an
    /// `Ok(Err(rejection))`.
    fn set_wallpaper(
        &self,
        _request: AppWallpaperSetRequest,
    ) -> ApplicationFuture<Result<AppWallpaperChange, AppWallpaperRejection>> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
}

/// Whether `id` is a wallpaper asset id, `^wp_[a-z0-9]{8,64}$`: always a
/// single safe path component.
pub(crate) fn is_asset_id(id: &str) -> bool {
    id.strip_prefix("wp_").is_some_and(|tail| {
        (8..=64).contains(&tail.len())
            && tail
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
    })
}

pub(crate) fn not_found() -> GatewayApplicationError {
    GatewayApplicationError::public(404, "wallpaper_not_found", "Wallpaper was not found.")
}

pub(crate) fn module_not_found() -> GatewayApplicationError {
    GatewayApplicationError::public(
        404,
        "wallpaper_module_not_found",
        "No user wallpaper module has that id.",
    )
}
