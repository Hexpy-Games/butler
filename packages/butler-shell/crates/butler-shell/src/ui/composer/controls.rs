//! `useComposerControls`, `useSessionControlSnapshot`, `useComposerControlHandlers` and
//! `useModelChoice`: the model catalog, Settings and chat controls the composer reads through
//! [`Jobs`], and the model, reasoning, access mode and plan mode it shows and persists.
use butler_ds::ui::context::Ds;
use butler_ds::ui::toast::{self, Toast};
use gpui::Context;
use serde_json::{Value, json};

use super::Composer;
use super::menus::ModelChoice;
use super::menus::model::model_choice;
use super::queue::{access_wire, effort_wire};
use super::state::{
    CatalogState, ComposerModelResolution, ComposerModelState, ComposerSettings, ControlsLoadState,
    ModelCatalog, ModelTruthInput, resolve_composer_model_truth, runtime_models,
};
use super::wire::{decode_catalog, decode_settings};
use crate::ui::i18n::composer::words;
use crate::ui::source::agent::Jobs;
use crate::ui::source::wire::{AccessMode, ReasoningEffort, SessionControlsView};

/// The catalog, Settings and chat controls, and what the composer shows of them.
pub(crate) struct Controls {
    pub(super) catalog: ModelCatalog,
    pub(super) catalog_state: CatalogState,
    pub(super) settings: ComposerSettings,
    pub(super) snapshot: Option<SessionControlsView>,
    pub(crate) load_state: ControlsLoadState,
    pub(super) shown: ComposerModelResolution,
    /// The owner chose a control in this chat (`composerSelectionTouchedRef`).
    touched: bool,
    /// The snapshot and catalog generations a refresh was already started for.
    refreshed: Option<String>,
}

impl Default for Controls {
    fn default() -> Self {
        Self {
            catalog: ModelCatalog::default(),
            catalog_state: CatalogState::Loading,
            settings: ComposerSettings {
                model: String::new(),
                reasoning_effort: ReasoningEffort::Medium,
                access_mode: AccessMode::AskExceptReads,
                plan_mode_default: false,
            },
            snapshot: None,
            load_state: ControlsLoadState::Loading,
            shown: ComposerModelResolution {
                state: ComposerModelState::Loading,
                model: String::new(),
                metadata: None,
                reasoning: ReasoningEffort::Medium,
                access_mode: AccessMode::AskExceptReads,
                plan_mode: false,
                generation_mismatch: false,
            },
            touched: false,
            refreshed: None,
        }
    }
}

impl Controls {
    /// The owner chose a control in this chat.
    pub(super) fn touched(&self) -> bool {
        self.touched
    }

    /// A chat change: the next chat's controls come from its own snapshot.
    pub(super) fn reset_chat(&mut self) {
        self.snapshot = None;
        self.touched = false;
        self.refreshed = None;
        self.load_state = ControlsLoadState::Loading;
    }
}

/// `setModelCatalog`: ready when the catalog offers a runtime model, else unavailable.
fn loaded_state(catalog: &ModelCatalog) -> CatalogState {
    if runtime_models(catalog).is_empty() {
        CatalogState::Unavailable
    } else {
        CatalogState::Ready
    }
}

impl Composer {
    /// The agent attached: reads the catalog, Settings and the open chat's controls.
    pub(super) fn load_controls(&mut self, cx: &mut Context<Self>) {
        self.controls.catalog_state = CatalogState::Loading;
        Self::load_catalog(cx);
        Self::load_settings(cx);
        self.load_session_controls(false, cx);
    }

    fn load_catalog(cx: &mut Context<Self>) {
        let fetch = Jobs::run(cx, |client| async move { client.get_model_catalog().await });
        cx.spawn(async move |this, cx| {
            let Some(loaded) = fetch.await else { return };
            let _ = this.update(cx, |this, cx| {
                match loaded.ok().and_then(|value| decode_catalog(&value)) {
                    Some(catalog) => {
                        this.controls.catalog = catalog;
                        this.controls.catalog_state = loaded_state(&this.controls.catalog);
                    }
                    None => this.controls.catalog_state = CatalogState::Error,
                }
                this.resolve(cx);
            });
        })
        .detach();
    }

    fn load_settings(cx: &mut Context<Self>) {
        let fetch = Jobs::run(cx, |client| async move { client.get_settings().await });
        cx.spawn(async move |this, cx| {
            let Some(loaded) = fetch.await else { return };
            let _ = this.update(cx, |this, cx| {
                if let Some(settings) = loaded.ok().and_then(|value| decode_settings(&value)) {
                    this.controls.settings = settings;
                    this.resolve(cx);
                }
            });
        })
        .detach();
    }

    /// `useSessionControlSnapshot`: a chat not yet created shows the Settings controls; a started
    /// one reads its own. `quiet` rereads in place, without returning to the loading state.
    pub(super) fn load_session_controls(&mut self, quiet: bool, cx: &mut Context<Self>) {
        let Some(session) = self.inputs.session_id.clone() else {
            self.controls.snapshot = None;
            self.controls.load_state = ControlsLoadState::Ready;
            self.resolve(cx);
            return;
        };
        if !self.inputs.connected {
            return;
        }
        if !quiet {
            self.controls.load_state = ControlsLoadState::Loading;
        }
        let requested = session.clone();
        let fetch = Jobs::run(cx, move |client| async move {
            client.session_controls(&requested).await
        });
        cx.spawn(async move |this, cx| {
            let Some(loaded) = fetch.await else { return };
            let _ = this.update(cx, |this, cx| this.controls_read(&session, loaded.ok(), cx));
        })
        .detach();
    }

    /// A controls read (or a persisted change) of `session` came back; `None` when it failed.
    fn controls_read(&mut self, session: &str, value: Option<Value>, cx: &mut Context<Self>) {
        if self.inputs.session_id.as_deref() != Some(session) {
            return;
        }
        match value.and_then(|value| serde_json::from_value::<SessionControlsView>(value).ok()) {
            Some(view) => {
                self.controls.snapshot = Some(view);
                self.controls.load_state = ControlsLoadState::Ready;
            }
            None => {
                self.controls.load_state = ControlsLoadState::Error;
                let lang = Ds::get(cx).lang();
                toast::show(cx, Toast::error(words(lang).controls_failed));
            }
        }
        self.resolve(cx);
    }

    /// `useComposerControls`' effect: the truth of the catalog, Settings and snapshot becomes
    /// what is shown, unless the owner chose in this chat.
    pub(super) fn resolve(&mut self, cx: &mut Context<Self>) {
        let plan_available = self.inputs.project_id.is_some();
        let truth = resolve_composer_model_truth(&ModelTruthInput {
            catalog: &self.controls.catalog,
            catalog_state: self.controls.catalog_state,
            controls: self.controls.snapshot.as_ref(),
            controls_state: self.controls.load_state,
            settings: &self.controls.settings,
            plan_mode_available: plan_available,
        });
        if truth.generation_mismatch {
            self.refresh_generation(cx);
        }
        let controls = &mut self.controls;
        if truth.state != ComposerModelState::Ready {
            controls.shown.state = truth.state;
            controls.shown.model = truth.model;
            controls.shown.metadata = truth.metadata;
        } else if !controls.touched {
            controls.shown = truth;
        } else {
            controls.shown.state = truth.state;
            let present = runtime_models(&controls.catalog)
                .iter()
                .any(|item| item.model_ref.as_ref() == controls.shown.model);
            if !present {
                // A model chosen here and then deleted gives way to the resolved one.
                controls.shown.model = truth.model;
                controls.shown.reasoning = truth.reasoning;
                controls.shown.metadata = truth.metadata;
            }
        }
        if !plan_available {
            controls.shown.plan_mode = false;
        }
        self.recompute(cx);
        cx.notify();
    }

    /// The chat's snapshot was made under another catalog: whichever side is older catches up.
    fn refresh_generation(&mut self, cx: &mut Context<Self>) {
        let Some(snapshot) = &self.controls.snapshot else {
            return;
        };
        let key = format!(
            "{}:{}",
            snapshot.catalog_generation, self.controls.catalog.generation
        );
        if self.controls.refreshed.as_ref() == Some(&key) {
            return;
        }
        self.controls.refreshed = Some(key);
        let generation = snapshot.catalog_generation.clone();
        let fetch = Jobs::run(cx, |client| async move { client.get_model_catalog().await });
        cx.spawn(async move |this, cx| {
            let Some(loaded) = fetch.await else { return };
            let _ = this.update(cx, |this, cx| match loaded {
                Ok(value) => match decode_catalog(&value) {
                    Some(catalog) if catalog.generation == generation => {
                        this.controls.catalog = catalog;
                        this.controls.catalog_state = loaded_state(&this.controls.catalog);
                        this.resolve(cx);
                    }
                    _ => this.load_session_controls(true, cx),
                },
                Err(_) => {
                    let lang = Ds::get(cx).lang();
                    toast::show(cx, Toast::error(words(lang).model_refresh_failed));
                }
            });
        })
        .detach();
    }

    /// The runtime model the composer shows, from the catalog.
    pub(super) fn active_model(&self) -> Option<&ModelChoice> {
        runtime_models(&self.controls.catalog)
            .into_iter()
            .find(|item| item.model_ref.as_ref() == self.controls.shown.model)
    }

    /// `persistControls`: a chat that exists keeps what the owner chose.
    fn persist(&mut self, patch: &Value, cx: &mut Context<Self>) {
        self.controls.touched = true;
        let Some(session) = self.inputs.session_id.clone() else {
            return;
        };
        let (requested, body) = (session.clone(), patch.clone());
        let fetch = Jobs::run(cx, move |client| async move {
            client.update_session_controls(&requested, &body).await
        });
        cx.spawn(async move |this, cx| {
            let Some(saved) = fetch.await else { return };
            let _ = this.update(cx, |this, cx| this.controls_read(&session, saved.ok(), cx));
        })
        .detach();
    }

    /// `handleAccessModeChange`.
    pub(super) fn set_access_mode(&mut self, mode: &AccessMode, cx: &mut Context<Self>) {
        self.controls.shown.access_mode = mode.clone();
        self.persist(&json!({ "access_mode": access_wire(mode) }), cx);
        cx.notify();
    }

    /// `handlePlanModeChange`.
    pub(super) fn set_plan_mode(&mut self, plan_mode: bool, cx: &mut Context<Self>) {
        self.controls.shown.plan_mode = plan_mode;
        self.persist(&json!({ "plan_mode": plan_mode }), cx);
        cx.notify();
    }

    /// `handleReasoningChange`.
    pub(super) fn set_reasoning(&mut self, effort: &ReasoningEffort, cx: &mut Context<Self>) {
        self.controls.shown.reasoning = effort.clone();
        self.persist(&json!({ "reasoning_effort": effort_wire(effort) }), cx);
        cx.notify();
    }

    /// `handleModelChoice`: the model and the reasoning it keeps or defaults to.
    pub(super) fn choose_model(&mut self, next: &ModelChoice, cx: &mut Context<Self>) {
        let (model, reasoning) = model_choice(next, &self.controls.shown.reasoning);
        self.controls.shown.model = model.to_string();
        self.controls.shown.metadata = Some(next.clone());
        self.controls.shown.reasoning = reasoning.clone();
        self.persist(
            &json!({ "model": model.to_string(), "reasoning_effort": effort_wire(&reasoning) }),
            cx,
        );
        self.recompute(cx);
        cx.notify();
    }
}
