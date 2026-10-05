//! Physical context admission prepared from the actual round wire body.
use super::*;

impl ModelProvider {
    pub(super) fn admission<'a>(
        &'a self,
        request: &ModelRoundRequest<'_>,
        config: &'a crate::models::ProviderRequestConfig,
        body: &serde_json::Value,
        serialized: Bytes,
        carrier: serialize::Carrier,
    ) -> Result<request_admission::PreparedRequestAdmission<'a>, ModelRoundError> {
        let codex_output = matches!(
            config.auth.mode(),
            ProviderAuthMode::CodexOauth | ProviderAuthMode::CodexSubscription
        )
        .then_some(request.max_output_tokens)
        .flatten();
        request_admission::PreparedRequestAdmission::new(
            &request_admission::PrepareAdmissionInput {
                catalog: &self.catalog,
                config: self.config.as_ref(),
                provider: &config.metadata.provider_id,
                model_ref: &config.metadata.model_ref,
                butler_data: None,
                requested_output_tokens: serialize::requested_output_tokens(
                    body,
                    carrier,
                    codex_output,
                ),
                context_window_tokens: (config.metadata.provider_id == "local")
                    .then_some(config.metadata.context_window_tokens)
                    .flatten(),
                max_output_tokens: (config.metadata.provider_id == "local")
                    .then_some(config.metadata.max_output_tokens)
                    .flatten(),
                body,
                serialized,
            },
        )
    }
}
