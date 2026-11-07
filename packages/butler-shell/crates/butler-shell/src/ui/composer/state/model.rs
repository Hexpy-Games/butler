//! `composerModelResolution.ts`: the model, reasoning, access and plan mode the composer shows.
//!
//! The wire module has no model catalog or settings types yet, so the fields the resolution
//! reads are declared here (`AppModelSummary`, `ModelCatalogView`, `SettingsView`).
#![allow(dead_code, reason = "P2 shell-wave: wired by Opus at wave integration")]
use crate::ui::source::wire::{AccessMode, ReasoningEffort, SessionControlsView};

/// `AppModelSummary`, the fields the composer reads.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ModelSummary {
    pub(crate) provider_id: String,
    pub(crate) model_ref: String,
    pub(crate) default_reasoning_effort: ReasoningEffort,
    pub(crate) reasoning_efforts: Vec<ReasoningEffort>,
    pub(crate) runtime_supported: bool,
    pub(crate) availability: Option<String>,
    pub(crate) image_input_support: Option<String>,
    pub(crate) image_accepted_mime_types: Option<Vec<String>>,
    pub(crate) image_max_inline_bytes: Option<i64>,
}

/// `ModelCatalogView`
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct ModelCatalog {
    pub(crate) generation: String,
    pub(crate) default_model_ref: String,
    pub(crate) registered_models: Option<Vec<ModelSummary>>,
    pub(crate) models: Vec<ModelSummary>,
}

/// `SettingsView`, the composer's defaults.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ComposerSettings {
    pub(crate) model: String,
    pub(crate) reasoning_effort: ReasoningEffort,
    pub(crate) access_mode: AccessMode,
    pub(crate) plan_mode_default: bool,
}

/// `ModelCatalogState`
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CatalogState {
    Loading,
    Ready,
    Unavailable,
    Error,
}

/// `ComposerModelState`
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum ComposerModelState {
    #[default]
    Loading,
    Ready,
    Unavailable,
}

/// `ControlsLoadState`
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ControlsLoadState {
    Loading,
    Ready,
    Error,
}

/// `ComposerModelResolution`
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ComposerModelResolution {
    pub(crate) state: ComposerModelState,
    pub(crate) model: String,
    pub(crate) metadata: Option<ModelSummary>,
    pub(crate) reasoning: ReasoningEffort,
    pub(crate) access_mode: AccessMode,
    pub(crate) plan_mode: bool,
    pub(crate) generation_mismatch: bool,
}

pub(crate) struct ModelTruthInput<'a> {
    pub(crate) catalog: &'a ModelCatalog,
    pub(crate) catalog_state: CatalogState,
    pub(crate) controls: Option<&'a SessionControlsView>,
    pub(crate) controls_state: ControlsLoadState,
    pub(crate) settings: &'a ComposerSettings,
    pub(crate) plan_mode_available: bool,
}

/// `runtimeModels`
pub(crate) fn runtime_models(catalog: &ModelCatalog) -> Vec<&ModelSummary> {
    let ready = |model: &&ModelSummary| {
        model.runtime_supported && model.availability.as_deref() == Some("ready")
    };
    match catalog.registered_models.as_deref() {
        Some(registered) if !registered.is_empty() => registered.iter().filter(ready).collect(),
        _ => catalog.models.iter().filter(ready).collect(),
    }
}

/// The model the composer shows. A model that no longer exists falls back to the Settings
/// default, then to the first available model; a failed controls read uses the Settings
/// controls. Only a catalog with no model at all leaves the composer without one.
pub(crate) fn resolve_composer_model_truth(input: &ModelTruthInput) -> ComposerModelResolution {
    let controls = input
        .controls
        .filter(|_| input.controls_state == ControlsLoadState::Ready);
    let reasoning = controls.map_or_else(
        || input.settings.reasoning_effort.clone(),
        |view| view.controls.reasoning_effort.clone(),
    );
    let access_mode = controls.map_or_else(
        || input.settings.access_mode.clone(),
        |view| view.controls.access_mode.clone(),
    );
    let plan_mode = input.plan_mode_available
        && controls.map_or(input.settings.plan_mode_default, |view| {
            view.controls.plan_mode
        });
    let generation_mismatch =
        controls.is_some_and(|view| view.catalog_generation != input.catalog.generation);
    let base = ComposerModelResolution {
        state: ComposerModelState::Loading,
        model: String::new(),
        metadata: None,
        reasoning,
        access_mode,
        plan_mode,
        generation_mismatch,
    };
    let selected = controls.map_or(input.settings.model.as_str(), |view| {
        view.controls.model.as_str()
    });
    let unavailable = (input.catalog.registered_models.iter().flatten()).find(|model| {
        model.model_ref == selected
            && model
                .availability
                .as_deref()
                .is_some_and(|availability| availability != "ready")
    });
    if let Some(model) = unavailable {
        return ComposerModelResolution {
            state: ComposerModelState::Unavailable,
            model: selected.to_owned(),
            metadata: Some(model.clone()),
            ..base
        };
    }
    let models = runtime_models(input.catalog);
    let Some(first) = models.first() else {
        let settled = matches!(
            input.catalog_state,
            CatalogState::Ready | CatalogState::Unavailable
        );
        return ComposerModelResolution {
            state: if settled {
                ComposerModelState::Unavailable
            } else {
                ComposerModelState::Loading
            },
            ..base
        };
    };
    if input.controls_state == ControlsLoadState::Loading {
        return base;
    }
    let preferred = [
        controls.map(|view| view.controls.model.as_str()),
        Some(input.settings.model.as_str()),
        Some(input.catalog.default_model_ref.as_str()),
    ];
    let metadata = (preferred.into_iter().flatten())
        .find_map(|model_ref| models.iter().find(|model| model.model_ref == model_ref))
        .unwrap_or(first);
    let reasoning = if metadata.reasoning_efforts.contains(&base.reasoning) {
        base.reasoning.clone()
    } else {
        metadata.default_reasoning_effort.clone()
    };
    ComposerModelResolution {
        state: ComposerModelState::Ready,
        model: metadata.model_ref.clone(),
        metadata: Some((*metadata).clone()),
        reasoning,
        ..base
    }
}
