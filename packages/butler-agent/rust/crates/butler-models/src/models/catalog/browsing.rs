//! Pure browsing selection: account boundary, family sibling, preset, conversation.
use serde::Serialize;

use super::{ModelPreset, ModelProviderMetadata, ModelTier, ReasoningEffort};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowsingRule {
    FamilySibling,
    ProviderPreset,
    PlanningPreset,
    Conversation,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct BrowsingResolution {
    pub model: String,
    pub effort: ReasoningEffort,
    pub rule: BrowsingRule,
}

/// Family names are the leading alphabetic component of a catalog model id,
/// independent of the reseller's provider id and the family's version or tier.
pub fn model_family(model_id: &str) -> String {
    model_id
        .rsplit('/')
        .next()
        .unwrap_or(model_id)
        .chars()
        .take_while(char::is_ascii_alphabetic)
        .collect::<String>()
        .to_ascii_lowercase()
}

/// All candidates must already be registered on the conversation's account.
/// `multi_vendor` describes the provider's complete catalog, not just the user's
/// registrations. Input order breaks ties between equally eligible siblings.
pub fn resolve_browsing_model(
    conversation: &ModelProviderMetadata,
    effort: ReasoningEffort,
    registered: &[ModelProviderMetadata],
    multi_vendor: bool,
    preset: Option<&ModelPreset>,
    planning: Option<&ModelPreset>,
) -> BrowsingResolution {
    let usable = |model: &&ModelProviderMetadata| {
        model.provider_id == conversation.provider_id
            && model.credential_id == conversation.credential_id
            && model.auth_type == conversation.auth_type
            && model.api_base_url == conversation.api_base_url
            && model.server_url == conversation.server_url
            && model.extensions.get("auth_profile") == conversation.extensions.get("auth_profile")
            && model.registered == Some(true)
            && model.enabled != Some(false)
            && model.runtime_supported
            && !model.is_image_output()
    };
    let family = model_family(&conversation.model_id);
    if multi_vendor
        && !family.is_empty()
        && let Some(model) = registered.iter().filter(usable).find(|model| {
            model_family(&model.model_id) == family && model.tier == Some(ModelTier::Efficient)
        })
    {
        return BrowsingResolution {
            model: model.model_ref.clone(),
            effort: model.default_reasoning_effort,
            rule: BrowsingRule::FamilySibling,
        };
    }
    for (preset, rule) in [
        (preset, BrowsingRule::ProviderPreset),
        (planning, BrowsingRule::PlanningPreset),
    ] {
        if let Some(preset) = preset
            && let Some(model) = registered.iter().filter(usable).find(|model| {
                model.model_ref == preset.model && model.supports_preset_effort(preset.effort)
            })
        {
            return BrowsingResolution {
                model: model.model_ref.clone(),
                effort: preset.effort,
                rule,
            };
        }
    }
    BrowsingResolution {
        model: conversation.model_ref.clone(),
        effort,
        rule: BrowsingRule::Conversation,
    }
}

pub(super) fn auto_resolutions(
    view: &super::ModelCatalogView,
) -> serde_json::Map<String, serde_json::Value> {
    let mut result = serde_json::Map::new();
    for conversation in view.models.iter().chain(&view.registered_models) {
        let family = model_family(&conversation.model_id);
        let multi_vendor = view.models.iter().any(|model| {
            model.provider_id == conversation.provider_id && model_family(&model.model_id) != family
        });
        let presets = view
            .providers
            .iter()
            .find(|provider| provider.provider_id == conversation.provider_id)
            .and_then(|provider| provider.presets.as_ref());
        let resolution = resolve_browsing_model(
            conversation,
            conversation.default_reasoning_effort,
            &view.registered_models,
            multi_vendor,
            presets.and_then(|presets| presets.browsing.as_ref()),
            presets.and_then(|presets| presets.planning.as_ref()),
        );
        let mut value = serde_json::json!(resolution);
        value["available"] = serde_json::json!(view.registered_models.iter().any(|model| {
            model.model_ref == resolution.model
                && model.runtime_supported
                && model.enabled != Some(false)
        }));
        result.insert(conversation.model_ref.clone(), value);
    }
    result
}
