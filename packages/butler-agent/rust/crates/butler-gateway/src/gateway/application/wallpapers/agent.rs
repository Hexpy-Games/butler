//! The agent's wallpaper route. A requested source is checked against the
//! setting's source rules and the module manifests, its image options are
//! completed (an attachment is promoted once, then reused), and it is written
//! to the global setting or a project's preferences with origin "agent".
//! Anything the caller can correct comes back as a rejection naming the field.

use serde_json::{Map, Value, json};

use super::super::settings;
use super::change::WallpaperOrigin;
use crate::gateway::{
    AppApplication, AppWallpaperChange, AppWallpaperRejection, AppWallpaperScope,
    AppWallpaperSetRequest, GatewayApplicationError, wallpaper_modules::WallpaperModules,
};

type Checked<T> = Result<T, AppWallpaperRejection>;
type Outcome<T> = Result<Checked<T>, GatewayApplicationError>;

const KINDS: [&str; 4] = ["none", "live", "image", "image_from_attachment"];
const INHERIT: &str = "inherit";
/// Stands in for the asset an attachment becomes while the rest is checked.
const PENDING_ASSET: &str = "wp_pending00";

/// A request whose shape is checked; `source` is complete but for an
/// attachment's asset and a defaulted dim.
struct Draft {
    source: Value,
    attachment: Option<String>,
    default_dim: bool,
}

impl AppApplication {
    pub(super) async fn set_wallpaper_owned(
        &self,
        request: AppWallpaperSetRequest,
    ) -> Outcome<AppWallpaperChange> {
        let AppWallpaperSetRequest {
            scope,
            project_id,
            source,
        } = request;
        let project_id = match (scope, project_id) {
            (AppWallpaperScope::Global, _) => None,
            (AppWallpaperScope::Project, Some(id)) if !id.trim().is_empty() => Some(id),
            (AppWallpaperScope::Project, _) => {
                let rule = "is required for scope project";
                return Ok(Err(AppWallpaperRejection::invalid(
                    "project_id",
                    rule,
                    None,
                )));
            }
        };
        let modules = self.selectable_modules().await?;
        let draft = match draft(&source, scope, &modules) {
            Ok(draft) => draft,
            Err(rejection) => return Ok(Err(rejection)),
        };
        if let Some(id) = project_id.as_deref()
            && let Err(error) = self.project_wallpaper(id).await
        {
            return rejected(error, "project_id").map(Err);
        }
        let next = match self.complete(draft).await? {
            Ok(next) => next,
            Err(rejection) => return Ok(Err(rejection)),
        };
        let previous = match project_id.as_deref() {
            None => {
                let patch = json!({"wallpaper": {"source": next}});
                let written = self.update_settings_from(patch, WallpaperOrigin::Agent);
                written.await.map(|(previous, _)| previous)
            }
            Some(id) => {
                let written = self.set_project_wallpaper(id, &next, WallpaperOrigin::Agent);
                written.await
            }
        };
        let previous = match previous {
            Ok(previous) => previous,
            Err(error) => return rejected(error, "source").map(Err),
        };
        Ok(Ok(AppWallpaperChange {
            scope,
            project_id,
            changed: previous != next,
            previous,
            next,
        }))
    }

    /// Resolves the draft's image: the attachment's asset (promoted on first
    /// use) or the named one, with the dim its luminance suggests.
    async fn complete(&self, draft: Draft) -> Outcome<Value> {
        let Draft {
            mut source,
            attachment,
            default_dim,
        } = draft;
        if source.get("kind").and_then(Value::as_str) != Some("image") {
            return Ok(Ok(source));
        }
        let asset = match attachment {
            Some(file_id) => match self.wallpaper_from_attachment(file_id).await {
                Ok(asset) => asset,
                Err(error) => return rejected(error, "source.attachment_id").map(Err),
            },
            None => {
                let id = source["asset"].as_str().unwrap_or_default().to_owned();
                match self.wallpaper_asset(id).await? {
                    Some(asset) => asset,
                    None => return Ok(Err(unknown_image())),
                }
            }
        };
        source["asset"] = json!(asset.id);
        if default_dim {
            source["dim"] = json!(default_dim_for(asset.luminance));
        }
        Ok(Ok(source))
    }
}

/// Checks the request's shape, then its modules (among `modules`) and
/// parameters.
fn draft(source: &Value, scope: AppWallpaperScope, modules: &WallpaperModules) -> Checked<Draft> {
    let project = scope == AppWallpaperScope::Project;
    let kinds: Vec<&str> = KINDS
        .into_iter()
        .chain(project.then_some(INHERIT))
        .collect();
    let kind = match source {
        Value::String(text) if text == INHERIT => INHERIT,
        Value::Object(object) => object.get("kind").and_then(Value::as_str).unwrap_or(""),
        _ => "",
    };
    if kind == INHERIT && project {
        if let Some(extra) = source
            .as_object()
            .and_then(|o| o.keys().find(|key| *key != "kind"))
        {
            let rule = "is not supported with kind inherit";
            return Err(AppWallpaperRejection::invalid(
                &format!("source.{extra}"),
                rule,
                None,
            ));
        }
        return Ok(Draft {
            source: json!(INHERIT),
            attachment: None,
            default_dim: false,
        });
    }
    if !kinds.contains(&kind) {
        let rule = if kind == INHERIT {
            "\"inherit\" applies to a project only; choose a source for the global wallpaper"
        } else {
            "must be one of the source kinds"
        };
        return Err(AppWallpaperRejection::invalid(
            "source.kind",
            rule,
            Some(json!(kinds)),
        ));
    }
    let mut object = source.as_object().cloned().unwrap_or_default();
    let attachment = (kind == "image_from_attachment")
        .then(|| attachment_id(&mut object))
        .transpose()?;
    let default_dim = kind.starts_with("image") && image_defaults(&mut object);
    let source = Value::Object(object);
    settings::check_agent_wallpaper_source(&source)
        .map_err(|(field, rule)| AppWallpaperRejection::invalid(&field, &rule, None))?;
    match (kind, source.get("filter")) {
        ("live", _) => modules.check_live(&source)?,
        (_, Some(filter)) => modules.check_filter(filter)?,
        _ => {}
    }
    Ok(Draft {
        source,
        attachment,
        default_dim,
    })
}

/// Takes `attachment_id` out of an `image_from_attachment` source, which
/// becomes an image source with a pending asset.
fn attachment_id(object: &mut Map<String, Value>) -> Checked<String> {
    let id = object
        .remove("attachment_id")
        .and_then(|id| id.as_str().map(str::trim).map(str::to_owned))
        .filter(|id| !id.is_empty())
        .ok_or_else(|| {
            let rule = "must be the id of an image attached to the conversation";
            AppWallpaperRejection::invalid("source.attachment_id", rule, None)
        })?;
    object.insert("kind".into(), json!("image"));
    object.insert("asset".into(), json!(PENDING_ASSET));
    Ok(id)
}

/// Fills `fit: "cover"` and `blur: 0`; returns whether `dim` is left to the
/// image's luminance.
fn image_defaults(object: &mut Map<String, Value>) -> bool {
    object.entry("fit").or_insert_with(|| json!("cover"));
    object.entry("blur").or_insert_with(|| json!(0));
    let default_dim = !object.contains_key("dim");
    object.entry("dim").or_insert_with(|| json!(0));
    default_dim
}

/// The UI's `wallpaperImageDefaultDim`: brighter images dim more,
/// clamp(0.6 × (luminance − 0.2), 0, 0.4) on the 0.05 grid.
pub(in crate::gateway::application) fn default_dim_for(luminance: f64) -> f64 {
    if luminance.is_nan() {
        return 0.2;
    }
    let dim = ((luminance - 0.2) * 0.6).clamp(0.0, 0.4);
    ((dim / 0.05).round() * 5.0).round() / 100.0
}

fn unknown_image() -> AppWallpaperRejection {
    let rule = "names no uploaded wallpaper image: call list_wallpapers for image ids, \
                or use kind image_from_attachment for an image attached to the conversation";
    AppWallpaperRejection::new(400, "wallpaper_image_not_found", "source.asset", rule, None)
}

/// A public (4xx) failure of a step is a rejection of `field` (of
/// `project_id` for a missing project) with the step's code and message;
/// anything else stays a failure.
fn rejected(
    error: GatewayApplicationError,
    field: &str,
) -> Result<AppWallpaperRejection, GatewayApplicationError> {
    match error {
        GatewayApplicationError::Public {
            status,
            code,
            message,
            ..
        } if status < 500 => {
            let field = if code == "project_not_found" {
                "project_id"
            } else {
                field
            };
            Ok(AppWallpaperRejection {
                status,
                code,
                message: format!("{field}: {message}"),
                field: field.to_owned(),
                allowed: None,
            })
        }
        error => Err(error),
    }
}
