//! The settings data the pages share (`useButlerStore.settings`, `modelCatalog`,
//! `setModelCatalog`) and the save of `settingsUIStore.update`. Section-local data stays in the
//! section's page as a [`Load`], filled by [`fetch`] (shared with the management pages).
use std::rc::Rc;

use butler_ds::ui::context::Ds;
use butler_ds::ui::toast::{self, Toast, ToastId};
use butler_shell_client::Error;
use gpui::{Context, EventEmitter, SharedString};
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

use super::Subpage;
use super::confirm::Pending;
use super::sections::SectionId;
use crate::ui::composer::decode_catalog;
use crate::ui::composer::menus::ModelChoice;
use crate::ui::i18n::settings::words;
pub(crate) use crate::ui::source::fetch::{Load, fetch, fetch_if};

/// What the settings tell the window: new settings (applied app-wide), a page to show, a chat to
/// open, run the setup again, or close.
#[derive(Clone, Debug)]
pub(crate) enum SettingsEvent {
    Changed(Rc<Value>),
    Open(SectionId),
    OpenSession(SharedString),
    /// `openHistory("settings")`: the browser history page, with Settings as its parent.
    OpenHistory,
    RerunSetup,
    Close,
}

/// `settingsUIStore.update(partial, setSettings, {optimistic, silent})`: `optimistic` shows the
/// patch before the agent answers; `silent` skips the Saved toast.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct Save {
    pub(crate) optimistic: bool,
    pub(crate) silent: bool,
}

/// `{...base, ...patch}`
fn merged(base: Option<&Value>, patch: &Value) -> Value {
    let mut next = base.cloned().unwrap_or_else(|| Value::Object(Map::new()));
    if let (Some(next), Some(patch)) = (next.as_object_mut(), patch.as_object()) {
        for (key, value) in patch {
            next.insert(key.clone(), value.clone());
        }
    }
    next
}

pub(crate) struct SettingsState {
    pub(super) connector_version: u64,
    /// GET /settings; replaced by each save's merged result.
    settings: Option<Rc<Value>>,
    /// GET /model-catalog
    catalog: Option<Rc<Value>>,
    saving: bool,
    pub(super) subpage: Option<Subpage>,
    pub(super) pending_confirm: Option<Pending>,
    /// The `settings-update` toast, replaced by the next save's.
    toast: Option<ToastId>,
}

impl EventEmitter<SettingsEvent> for SettingsState {}

impl SettingsState {
    pub(super) fn new(settings: Option<Rc<Value>>) -> Self {
        Self {
            connector_version: 0,
            settings,
            catalog: None,
            saving: false,
            subpage: None,
            pending_confirm: None,
            toast: None,
        }
    }

    pub(crate) fn settings(&self) -> Option<&Value> {
        self.settings.as_deref()
    }

    /// The part of the settings a section reads, deserialized into its own struct.
    pub(crate) fn slice<T: DeserializeOwned>(&self) -> Option<T> {
        <T as serde::Deserialize>::deserialize(self.settings.as_deref()?).ok()
    }

    pub(crate) fn catalog(&self) -> Option<&Value> {
        self.catalog.as_deref()
    }

    /// `runtimeModels(modelCatalog)`: the ready registered models when any are registered, else
    /// the ready catalog models.
    pub(crate) fn runtime_models(&self) -> Vec<ModelChoice> {
        let Some(catalog) = self.catalog().and_then(decode_catalog) else {
            return Vec::new();
        };
        let models = match catalog.registered_models {
            Some(registered) if !registered.is_empty() => registered,
            _ => catalog.models,
        };
        models
            .into_iter()
            .filter(|model| {
                model.runtime_supported && model.availability.as_deref() == Some("ready")
            })
            .collect()
    }

    /// `useDeveloperMode`: `settings.diagnostics_enabled === true`.
    pub(crate) fn developer_mode(&self) -> bool {
        self.settings()
            .and_then(|settings| settings.get("diagnostics_enabled"))
            .and_then(Value::as_bool)
            == Some(true)
    }

    pub(crate) fn saving(&self) -> bool {
        self.saving
    }

    /// The settings and the catalog, read on open.
    pub(super) fn load(cx: &mut Context<Self>) {
        fetch(
            cx,
            |client| async move { client.get_settings().await },
            |this: &mut Self, result: Result<Value, Error>, cx| {
                if let Ok(settings) = result {
                    this.set_settings(settings, cx);
                }
            },
        );
        Self::reload_catalog(cx);
    }

    /// `setModelCatalog` after a fresh `/model-catalog`.
    pub(crate) fn reload_catalog(cx: &mut Context<Self>) {
        fetch(
            cx,
            |client| async move { client.get_model_catalog().await },
            |this: &mut Self, result: Result<Value, Error>, _| {
                if let Ok(catalog) = result {
                    this.catalog = Some(Rc::new(catalog));
                }
            },
        );
    }

    fn set_settings(&mut self, settings: Value, cx: &mut Context<Self>) {
        let settings = Rc::new(settings);
        self.settings = Some(settings.clone());
        cx.emit(SettingsEvent::Changed(settings));
        cx.notify();
    }

    /// Shows `next` as the `settings-update` toast, in place of the last one.
    fn notify_saved(&mut self, next: Toast, cx: &mut Context<Self>) {
        let next = match self.toast {
            Some(id) => next.id(id),
            None => next,
        };
        self.toast = Some(toast::show(cx, next));
    }

    /// `update`: PATCH /settings. Optimistic saves show the patch at once and roll back on a
    /// failure; the agent's answer is merged over the settings.
    pub(crate) fn save(&mut self, patch: Value, opts: Save, cx: &mut Context<Self>) {
        let previous = self.settings.clone();
        if opts.optimistic {
            self.set_settings(merged(previous.as_deref(), &patch), cx);
        }
        self.saving = true;
        cx.notify();
        fetch(
            cx,
            move |client| async move { client.update_settings(&patch).await },
            move |this: &mut Self, result: Result<Value, Error>, cx| {
                this.saving = false;
                let copy = words(Ds::get(cx).lang());
                match result {
                    Ok(saved) => {
                        let next = merged(this.settings(), &saved);
                        this.set_settings(next, cx);
                        if !opts.silent {
                            this.notify_saved(Toast::success(copy.saved), cx);
                        }
                    }
                    Err(_) => {
                        if opts.optimistic
                            && let Some(previous) = previous
                        {
                            this.settings = Some(previous.clone());
                            cx.emit(SettingsEvent::Changed(previous));
                        }
                        this.notify_saved(Toast::error(copy.save_failed), cx);
                    }
                }
            },
        );
    }
}
