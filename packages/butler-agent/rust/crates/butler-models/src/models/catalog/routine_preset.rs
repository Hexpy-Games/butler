//! The routine preset of a provider: the model and reasoning effort that
//! first-run setup makes the default when the user connects that provider
//! (#230).
//!
//! The static catalog JSON (presets, tiers) is owned by the catalog work.
//! Until its `presets.routine` entry lands, this reads the catalog's existing
//! `routine_work` worker preset, so callers already use the final accessor.

use serde::Serialize;

use super::{ModelCatalogSnapshot, ReasoningEffort};

/// Default model and effort for a newly connected provider.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct RoutinePreset {
    /// Namespaced model ref, e.g. `openai/gpt-6-sol`.
    pub model: String,
    pub effort: ReasoningEffort,
}

impl ModelCatalogSnapshot {
    /// The routine preset of `provider_id`, or `None` for a provider the
    /// catalog has no preset for (local servers, most OpenAI-compatible APIs).
    pub fn routine_preset(&self, provider_id: &str) -> Option<RoutinePreset> {
        self.static_catalog
            .presets
            .iter()
            .find(|preset| preset.provider_id == provider_id)
            .map(|preset| RoutinePreset {
                model: preset.routine_work.model.clone(),
                effort: preset.routine_work.reasoning_effort,
            })
    }
}
