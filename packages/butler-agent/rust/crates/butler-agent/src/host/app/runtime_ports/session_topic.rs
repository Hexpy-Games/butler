//! Smart-group classification on the turn's resolved native model.
use butler_gateway::gateway::{
    AppSessionTopicClassifier, AppSessionTopicInput, ApplicationFuture, SMART_GROUP_INSTRUCTIONS,
};
use butler_models::models::{ModelConfiguration, ModelProvider};
use butler_turn::btcc::ModelRoundMessage;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

use super::session_title::{BackgroundRound, background_round, lowest_effort};

pub(crate) struct AppSessionTopicClassifierAdapter {
    provider: Arc<ModelProvider>,
    configuration: Arc<ModelConfiguration>,
}

impl AppSessionTopicClassifierAdapter {
    pub(crate) fn new(models: &crate::host::ProcessModels) -> Self {
        Self {
            provider: models.provider.clone(),
            configuration: models.configuration.clone(),
        }
    }
}

impl AppSessionTopicClassifier for AppSessionTopicClassifierAdapter {
    fn classify(
        &self,
        input: AppSessionTopicInput,
        cancellation: CancellationToken,
    ) -> ApplicationFuture<String> {
        let provider = self.provider.clone();
        let configuration = self.configuration.clone();
        Box::pin(async move {
            let effort = lowest_effort(&configuration, &input.model_ref).await?;
            let messages = [ModelRoundMessage::user(input.request_json, None)];
            let result = background_round(
                &provider,
                BackgroundRound {
                    model: &input.model_ref,
                    instructions: SMART_GROUP_INSTRUCTIONS,
                    purpose: "smart_group",
                    effort: &effort,
                    usage_session_id: input.usage_session_id,
                },
                &messages,
                cancellation,
            )
            .await?;
            Ok(result
                .text
                .or_else(|| result.assistant_message.map(|m| m.content.to_string()))
                .unwrap_or_default())
        })
    }
}
