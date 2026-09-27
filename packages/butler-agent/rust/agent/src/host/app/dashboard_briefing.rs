//! App project briefing model calls through the existing process Models owner.

use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use crate::{
    gateway::{
        AppProjectDashboardBriefingPort, AppProjectDashboardBriefingPrompt, ApplicationFuture,
        GatewayApplicationError,
    },
    models::{
        ModelCatalog, ModelConfiguration, ModelProvider, PromptUsageAttribution,
        ProviderPromptLifecycle, ProviderPromptPort, ProviderPromptRequest, ReasoningEffort,
        TokenEstimateInput,
    },
};

pub(crate) struct AppDashboardBriefing {
    catalog: Arc<ModelCatalog>,
    configuration: Arc<ModelConfiguration>,
    provider: Arc<ModelProvider>,
    data_root: String,
}

impl AppDashboardBriefing {
    pub(crate) fn new(models: &crate::host::ProcessModels, data_root: &std::path::Path) -> Self {
        Self {
            catalog: models.catalog.clone(),
            configuration: models.configuration.clone(),
            provider: models.provider.clone(),
            data_root: data_root.to_string_lossy().into_owned(),
        }
    }
}

impl AppProjectDashboardBriefingPort for AppDashboardBriefing {
    fn estimate_tokens(&self, model_ref: String, text: String) -> ApplicationFuture<f64> {
        let catalog = self.catalog.clone();
        let configuration = self.configuration.clone();
        Box::pin(async move {
            let metadata = configuration
                .read_metadata()
                .await
                .map_err(GatewayApplicationError::internal_from)?;
            catalog
                .estimate_tokens(
                    &metadata.catalog,
                    TokenEstimateInput::Text(&text),
                    Some(&model_ref),
                )
                .map(|result| result.tokens)
                .map_err(GatewayApplicationError::internal_from)
        })
    }

    fn generate(
        &self,
        prompt: AppProjectDashboardBriefingPrompt,
        cancellation: CancellationToken,
    ) -> ApplicationFuture<String> {
        let provider = self.provider.clone();
        let data_root = self.data_root.clone();
        Box::pin(async move {
            let reasoning_effort = parse_effort(&prompt.reasoning_effort)?;
            let attribution = PromptUsageAttribution {
                turn_id: None,
                phase: Some(&prompt.usage_phase),
                round_index: None,
                reasoning_effort: Some(&reasoning_effort),
                requested_output_tokens: Some(prompt.requested_output_tokens as f64),
                budget_state: None,
                budget_state_source: None,
                prompt_sections: None,
            };
            provider
                .run_prompt(
                    ProviderPromptRequest {
                        prompt: &prompt.prompt,
                        model: Some(&prompt.model),
                        reasoning_effort: Some(&reasoning_effort),
                        instructions: Some(&prompt.instructions),
                        response_format: None,
                        cache_scope: Some(&prompt.cache_scope),
                        cache_boundary: None,
                        cancellation,
                        attachments: &[],
                        butler_data: Some(&data_root),
                        usage_attribution: Some(&attribution),
                        stream_observer: None,
                        provider_retry_attempts: None,
                    },
                    ProviderPromptLifecycle::none(),
                )
                .await
                .map(|result| result.text)
                .map_err(GatewayApplicationError::internal_from)
        })
    }
}

fn parse_effort(value: &str) -> Result<ReasoningEffort, GatewayApplicationError> {
    match value {
        "none" => Ok(ReasoningEffort::None),
        "low" => Ok(ReasoningEffort::Low),
        "medium" => Ok(ReasoningEffort::Medium),
        "high" => Ok(ReasoningEffort::High),
        "xhigh" => Ok(ReasoningEffort::Xhigh),
        "max" => Ok(ReasoningEffort::Max),
        _ => Err(GatewayApplicationError::internal()),
    }
}
