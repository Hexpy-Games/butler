//! The wallpaper modules the backend knows: their manifests for listing, and
//! the rules agent-written sources are checked against.
//!
//! Built-ins come from the UI package's module folders, their single source
//! of truth, bundled by `build.rs`; nothing is listed by hand. User modules
//! (`<BUTLER_HOME>/wallpapers/<id>/`, see [`user`]) join through
//! [`WallpaperModules::with`] after the same [`manifest::parse`] checks, and
//! can never shadow a built-in, as in the UI registry. A user module that
//! cannot be drawn is named through [`WallpaperModules::except`], so choosing
//! it is refused with the reason. The agent's saves are checked by [`save`].

pub(crate) mod import;
mod manifest;
pub(crate) mod save;
#[cfg(test)]
mod tests;
pub(crate) mod user;
mod values;
pub(crate) mod watch;

use std::sync::LazyLock;

use serde_json::{Value, json};

use crate::gateway::AppWallpaperRejection;
use manifest::parse;
pub(crate) use manifest::{WallpaperModule, is_image_file, is_module_id};
use values::check_values;

/// `[{"folder", "manifest": "<wallpaper.json text>"}]`, sorted by folder.
static BUNDLE: &str = include_str!(concat!(env!("OUT_DIR"), "/wallpaper-modules.json"));

/// Draws image sources for the engine; never a user-selectable module.
const ENGINE_IMAGE_MODULE: &str = "butler.image";

static BUILTIN: LazyLock<WallpaperModules> = LazyLock::new(|| {
    WallpaperModules::default().with(
        bundled(BUNDLE)
            .into_iter()
            .filter_map(|(_, module)| module.ok()),
    )
});

/// A lookup of validated modules in listing order; the first module with an
/// id wins.
#[derive(Clone, Debug, Default)]
pub(crate) struct WallpaperModules {
    modules: Vec<WallpaperModule>,
    /// User modules that cannot be drawn, with why: `(id, reason)`.
    unusable: Vec<(String, String)>,
}

impl WallpaperModules {
    pub(crate) fn builtin() -> &'static Self {
        &BUILTIN
    }

    /// These modules followed by `extra`, skipping ids already present and
    /// the engine's image module.
    pub(crate) fn with(&self, extra: impl IntoIterator<Item = WallpaperModule>) -> Self {
        let mut modules = self.modules.clone();
        for module in extra {
            if module.id != ENGINE_IMAGE_MODULE && modules.iter().all(|seen| seen.id != module.id) {
                modules.push(module);
            }
        }
        Self {
            modules,
            unusable: self.unusable.clone(),
        }
    }

    /// These modules, refusing each of `unusable` (`(id, reason)`) with its
    /// reason unless a listed module has that id.
    pub(crate) fn except(mut self, unusable: impl IntoIterator<Item = (String, String)>) -> Self {
        self.unusable.extend(unusable);
        self
    }

    /// Listing entries of built-in modules: each manifest with
    /// `source: "builtin"` and `status: {state: "ok"}`, and for an agent
    /// what [`describe_for_agent`] adds.
    pub(crate) fn builtin_entries(&self, agent: bool) -> Vec<Value> {
        self.modules
            .iter()
            .map(|module| {
                let mut manifest = module.manifest.clone();
                if let Some(entry) = manifest.as_object_mut() {
                    entry.insert("source".into(), json!("builtin"));
                    entry.insert("status".into(), json!({"state": "ok"}));
                }
                if agent {
                    describe_for_agent(&mut manifest, module);
                }
                manifest
            })
            .collect()
    }

    pub(crate) fn get(&self, id: &str) -> Option<&WallpaperModule> {
        self.modules.iter().find(|module| module.id == id)
    }

    /// A live source's module and parameters (`source.module`, `source.params`
    /// and `source.paramsDark`). Modules that require an image are filters,
    /// unless they bring a default image.
    pub(crate) fn check_live(&self, source: &Value) -> Result<(), AppWallpaperRejection> {
        let live = self.ids(WallpaperModule::is_live);
        let module = self.module(source, "source.module", &live)?;
        if !module.is_live() {
            let rule = format!(
                "is {}, which only filters an image: use it as source.filter of an image source",
                module.id
            );
            return Err(AppWallpaperRejection::invalid(
                "source.module",
                &rule,
                Some(live),
            ));
        }
        check_values(module, source.get("params"), "source.params")?;
        check_values(module, source.get("paramsDark"), "source.paramsDark")
    }

    /// An image source's `filter`: a module that takes an image.
    pub(crate) fn check_filter(&self, filter: &Value) -> Result<(), AppWallpaperRejection> {
        let filters = self.ids(WallpaperModule::is_filter);
        let module = self.module(filter, "source.filter.module", &filters)?;
        if !module.is_filter() {
            let rule = format!("is {}, which does not take an image", module.id);
            let field = "source.filter.module";
            return Err(AppWallpaperRejection::invalid(field, &rule, Some(filters)));
        }
        check_values(module, filter.get("params"), "source.filter.params")?;
        check_values(module, filter.get("paramsDark"), "source.filter.paramsDark")
    }

    fn module(
        &self,
        source: &Value,
        field: &str,
        allowed: &Value,
    ) -> Result<&WallpaperModule, AppWallpaperRejection> {
        let id = source.get("module").and_then(Value::as_str);
        if let Some(module) = id.and_then(|id| self.get(id)) {
            return Ok(module);
        }
        let unusable = id.and_then(|id| self.unusable.iter().find(|(name, _)| name == id));
        let rule = match unusable {
            Some((id, reason)) => {
                let rule = format!(
                    "is {id}, a user module that cannot be drawn: {}. Fix its files, call \
                     list_wallpapers until its status is ok, then retry",
                    reason.trim().trim_end_matches('.')
                );
                let code = "wallpaper_module_error";
                return Err(AppWallpaperRejection::new(
                    400,
                    code,
                    field,
                    &rule,
                    Some(allowed.clone()),
                ));
            }
            None => "names no installed wallpaper module",
        };
        Err(AppWallpaperRejection::invalid(
            field,
            rule,
            Some(allowed.clone()),
        ))
    }

    fn ids(&self, keep: impl Fn(&WallpaperModule) -> bool) -> Value {
        json!(
            self.modules
                .iter()
                .filter(|module| keep(module))
                .map(|module| module.id.as_str())
                .collect::<Vec<_>>()
        )
    }
}

/// Adds to a module's listing entry how an agent can use it: `uses` (`live`
/// and/or `filter`), `photo` when a live source shows the module's bundled
/// image, and `realtimeParam`, the boolean param that makes the scene follow
/// the local time of day.
pub(crate) fn describe_for_agent(entry: &mut Value, module: &WallpaperModule) {
    let Some(entry) = entry.as_object_mut() else {
        return;
    };
    let uses: Vec<&str> = [(module.is_live(), "live"), (module.is_filter(), "filter")]
        .into_iter()
        .filter_map(|(usable, name)| usable.then_some(name))
        .collect();
    entry.insert("uses".into(), json!(uses));
    if module.default_image.is_some() && module.is_filter() {
        entry.insert("photo".into(), json!(true));
    }
    if let Some(param) = &module.scene_tone {
        entry.insert("realtimeParam".into(), json!(param));
    }
}

/// Each bundled folder with its parsed module; a module's id must name its
/// folder.
fn bundled(bundle: &str) -> Vec<(String, Result<WallpaperModule, Vec<String>>)> {
    #[derive(serde::Deserialize)]
    struct Entry {
        folder: String,
        manifest: String,
    }
    let entries: Vec<Entry> = serde_json::from_str(bundle).unwrap_or_default();
    entries
        .into_iter()
        .map(|entry| {
            let module = parse(&entry.manifest).and_then(|module| {
                if module.id == entry.folder {
                    Ok(module)
                } else {
                    Err(vec![format!("id: must name its folder {}", entry.folder)])
                }
            });
            (entry.folder, module)
        })
        .collect()
}
