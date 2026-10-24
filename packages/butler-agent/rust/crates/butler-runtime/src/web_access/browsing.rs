//! Turn-scoped browsing model selection over the existing Models configuration.
use super::WebSession;
use butler_models::models::{ProviderPromptPort, ReasoningEffort};
use std::sync::Arc;

pub struct BrowseModel {
    pub model: String,
    pub effort: ReasoningEffort,
    pub prompt: Arc<dyn ProviderPromptPort>,
}

impl WebSession {
    pub async fn browsing_model(
        &self,
        conversation: &str,
        effort: ReasoningEffort,
        setting: &str,
    ) -> Option<BrowseModel> {
        let configuration = self.access.configuration()?;
        let read = configuration.read().await.ok()?;
        if setting == "off" {
            return None;
        }
        let (model, effort) = if setting == "auto" {
            let view = read.catalog.view();
            let conversation = read.catalog.find_model_metadata(Some(conversation))?;
            let family = butler_models::models::model_family(&conversation.model_id);
            let multi = view.models.iter().any(|model| {
                model.provider_id == conversation.provider_id
                    && butler_models::models::model_family(&model.model_id) != family
            });
            let preset = view
                .providers
                .iter()
                .find(|provider| provider.provider_id == conversation.provider_id)
                .and_then(|provider| provider.presets.as_ref())
                .and_then(|presets| presets.browsing.as_ref());
            let resolved = butler_models::models::resolve_browsing_model(
                &conversation,
                effort,
                &view.registered_models,
                multi,
                preset,
            );
            (resolved.model, resolved.effort)
        } else {
            let metadata = read.catalog.find_model_metadata(Some(setting))?;
            if metadata.registered != Some(true)
                || metadata.enabled == Some(false)
                || !metadata.runtime_supported
            {
                return None;
            }
            (metadata.model_ref, metadata.default_reasoning_effort)
        };
        Some(BrowseModel {
            model,
            effort,
            prompt: self.access.prompt()?.clone(),
        })
    }

    pub async fn browse_read(
        &self,
        args: &serde_json::Value,
        live: super::LivePage,
        cancellation: &tokio_util::sync::CancellationToken,
    ) -> Result<serde_json::Value, super::service::WebAccessError> {
        // Independent observation history: shared configuration, provider and provenance,
        // but no earlier window may replace this request's only page view.
        let session = self.access.session_for_turn(String::new());
        session
            .web_read_from(args, Some(live), true, cancellation)
            .await
    }

    pub fn browse_usage_root(&self) -> Option<&str> {
        self.usage_attribution
            .as_ref()
            .and_then(|usage| usage.usage_root.as_deref())
    }
}
