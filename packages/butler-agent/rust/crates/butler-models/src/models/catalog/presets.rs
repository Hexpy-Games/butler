//! Per-provider default model presets and their refresh upgrade.
//!
//! Each setup provider carries a static `presets.routine` entry: the model and
//! effort a new user starts with. When a provider model-list refresh returns
//! a newer model of the same tier that Butler can serve, the preset moves to
//! it; without a refresh (or when it failed) the static preset stands.

use serde::{Deserialize, Serialize};

use super::{ModelTier, ReasoningEffort, parse_model_ref};

/// A default model choice: a catalog model ref and the effort to run it at.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ModelPreset {
    /// Namespaced model ref, e.g. `openai/gpt-6-sol`.
    pub model: String,
    /// Reasoning effort the preset runs at.
    pub effort: ReasoningEffort,
}

/// The presets one provider carries.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProviderPresets {
    /// Everyday default: the latest balanced-tier model at medium effort.
    pub routine: ModelPreset,
}

/// Static per-provider catalog entry.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct StaticProviderEntry {
    pub(crate) provider_id: String,
    pub(crate) presets: ProviderPresets,
}

/// A refreshed model id's tier and version, inferred from the provider's
/// naming scheme. Only providers with a stable scheme are inferred.
fn infer_tier_and_version(provider_id: &str, model_id: &str) -> Option<(ModelTier, Vec<u64>)> {
    let lower = model_id.to_ascii_lowercase();
    let tier = match provider_id {
        "openai" => openai_tier(&lower)?,
        "anthropic" => anthropic_tier(&lower)?,
        "google" => google_tier(&lower)?,
        _ => return None,
    };
    let version = numeric_version(&lower)?;
    Some((tier, version))
}

fn openai_tier(model: &str) -> Option<ModelTier> {
    let tail = model.strip_prefix("gpt-")?;
    let suffix = tail.trim_start_matches(|c: char| c.is_ascii_digit() || c == '.');
    match suffix {
        "-astra" => Some(ModelTier::Flagship),
        "-sol" | "-terra" => Some(ModelTier::Balanced),
        "-luna" => Some(ModelTier::Efficient),
        _ => None,
    }
}

fn anthropic_tier(model: &str) -> Option<ModelTier> {
    let family = model.strip_prefix("claude-")?.split('-').next()?;
    match family {
        "opus" | "fable" => Some(ModelTier::Flagship),
        "sonnet" => Some(ModelTier::Balanced),
        "haiku" => Some(ModelTier::Efficient),
        _ => None,
    }
}

fn google_tier(model: &str) -> Option<ModelTier> {
    let tail = model.strip_prefix("gemini-")?;
    let family = tail.trim_start_matches(|c: char| c.is_ascii_digit() || c == '.');
    match family {
        "-pro" => Some(ModelTier::Flagship),
        "-flash" => Some(ModelTier::Balanced),
        "-flash-lite" => Some(ModelTier::Efficient),
        _ => None,
    }
}

/// The dotted or dashed version numbers in a model id: `gpt-6.1-sol` → [6, 1],
/// `claude-sonnet-5-1` → [5, 1]. Date-like segments (8 digits) are ignored.
fn numeric_version(model: &str) -> Option<Vec<u64>> {
    let version = model
        .split(['-', '.'])
        .filter(|part| !part.is_empty() && part.len() < 8)
        .filter_map(|part| part.parse::<u64>().ok())
        .collect::<Vec<_>>();
    (!version.is_empty()).then_some(version)
}

/// The routine preset after a provider model-list refresh.
///
/// `refreshed` lists the model ids (or refs) the provider returned; `servable`
/// says whether Butler can run a model ref. A candidate replaces the static
/// preset only when its tier matches the static model's, its version is
/// higher, and it is servable. The effort stays the static one.
pub fn upgrade_routine_preset(
    provider_id: &str,
    static_preset: &ModelPreset,
    refreshed: &[String],
    servable: &dyn Fn(&str) -> bool,
) -> ModelPreset {
    let current = parse_model_ref(&static_preset.model);
    let Some((tier, mut best_version)) = infer_tier_and_version(provider_id, &current.model_id)
    else {
        return static_preset.clone();
    };
    let mut best = None;
    for id in refreshed {
        let model_id = id
            .strip_prefix(provider_id)
            .and_then(|rest| rest.strip_prefix('/'))
            .unwrap_or(id);
        let Some((candidate_tier, version)) = infer_tier_and_version(provider_id, model_id) else {
            continue;
        };
        let model_ref = format!("{provider_id}/{model_id}");
        if candidate_tier == tier && version > best_version && servable(&model_ref) {
            best_version = version;
            best = Some(model_ref);
        }
    }
    best.map_or_else(
        || static_preset.clone(),
        |model| ModelPreset {
            model,
            effort: static_preset.effort,
        },
    )
}
