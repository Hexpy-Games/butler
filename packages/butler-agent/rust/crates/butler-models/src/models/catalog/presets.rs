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
    /// Namespaced model ref, e.g. `openai/gpt-6.1-sol`.
    pub model: String,
    /// Reasoning effort the preset runs at.
    #[serde(default = "no_effort")]
    pub effort: ReasoningEffort,
}

impl super::ModelCatalogSnapshot {
    /// Lightweight query planning stays on the conversation's provider.
    pub fn search_planning_preset(&self, provider_id: &str) -> Option<ModelPreset> {
        let presets = self.static_catalog.provider_presets(provider_id)?;
        Some(presets.planning.unwrap_or(presets.routine))
    }
}

/// The presets one provider carries.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProviderPresets {
    /// Everyday default: the latest balanced-tier model at medium effort.
    pub routine: ModelPreset,
    /// Lightweight query planning; providers without one use routine.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planning: Option<ModelPreset>,
    /// Acceptance-tested browsing choice; absent until results exist.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browsing: Option<ModelPreset>,
}

/// How a provider bills requests made with an API key.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ApiKeyBilling {
    /// Per token, at the model's list price.
    PerToken,
    /// Against a subscription plan's quota (e.g. the GLM Coding Plan).
    Subscription,
}

/// Static per-provider catalog entry.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct StaticProviderEntry {
    pub(crate) provider_id: String,
    pub(crate) api_key_billing: ApiKeyBilling,
    pub(crate) presets: ProviderPresets,
    #[serde(default)]
    pub(crate) chat_wire_policy: super::ChatWirePolicy,
}

/// A refreshed model id's tier and version, inferred from the provider's
/// naming scheme. Only providers with a stable scheme are inferred.
pub(super) fn infer_tier_and_version(
    provider_id: &str,
    model_id: &str,
) -> Option<(ModelTier, Vec<u64>)> {
    let pattern = naming_pattern(model_id);
    let version = numeric_version(model_id)?;
    let schemes =
        TIER_SCHEMES.get_or_init(|| serde_json::from_str(include_str!("tier-schemes.json")).ok());
    let tier = schemes
        .as_ref()?
        .iter()
        .find(|scheme| {
            scheme.provider_id == provider_id
                && scheme.pattern == pattern
                && scheme
                    .min_version
                    .as_ref()
                    .is_none_or(|minimum| &version >= minimum)
        })?
        .tier;
    Some((tier, version))
}

#[derive(Deserialize)]
struct TierScheme {
    provider_id: String,
    pattern: String,
    tier: ModelTier,
    #[serde(default)]
    min_version: Option<Vec<u64>>,
}

static TIER_SCHEMES: std::sync::OnceLock<Option<Vec<TierScheme>>> = std::sync::OnceLock::new();

fn naming_pattern(model: &str) -> String {
    let mut chars = model
        .to_ascii_lowercase()
        .chars()
        .collect::<Vec<_>>()
        .into_iter()
        .peekable();
    let mut pattern = String::new();
    while let Some(ch) = chars.next() {
        if !ch.is_ascii_digit() {
            pattern.push(ch);
            continue;
        }
        pattern.push('#');
        while chars.peek().is_some_and(char::is_ascii_digit) {
            chars.next();
        }
        while chars.peek().is_some_and(|ch| matches!(ch, '.' | '-')) {
            let mut next = chars.clone();
            next.next();
            if !next.peek().is_some_and(char::is_ascii_digit) {
                break;
            }
            chars.next();
            while chars.peek().is_some_and(char::is_ascii_digit) {
                chars.next();
            }
        }
    }
    pattern
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
/// `refreshed` lists the model ids (or refs) the provider returned. A
/// candidate replaces the static preset only when its tier matches the static
/// model's, its version is higher, and `runs(model_ref, effort)` confirms
/// Butler can run it at the static preset's effort, which it keeps.
pub fn upgrade_routine_preset(
    provider_id: &str,
    static_preset: &ModelPreset,
    refreshed: &[String],
    runs: &dyn Fn(&str, ReasoningEffort) -> bool,
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
        if candidate_tier == tier
            && version > best_version
            && runs(&model_ref, static_preset.effort)
        {
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

fn no_effort() -> ReasoningEffort {
    ReasoningEffort::None
}

impl super::ModelProviderMetadata {
    /// Models without effort controls run presets with no effort.
    pub fn supports_preset_effort(&self, effort: ReasoningEffort) -> bool {
        if self.reasoning_efforts.is_empty() {
            effort == ReasoningEffort::None
        } else {
            self.reasoning_efforts.contains(&effort)
        }
    }
}
