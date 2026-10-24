use super::*;
impl ModelProvider {
    pub(super) async fn finish_round(
        &self,
        request: ModelRoundRequest<'_>,
        config: super::super::ProviderRequestConfig,
        mut sent: dispatch::DispatchedResponse,
        watch: StreamWatch<'_>,
        options: (bool, bool, bool),
        mut retry: super::super::chatgpt_plan::retry::Retry,
    ) -> Result<ModelRoundResult, ModelRoundError> {
        let (local_stream, include_usage, include_summary) = options;
        let carrier = sent.prepared.carrier;
        let prefix = (!sent.prepared.prefix.is_null()).then_some(&sent.prepared.prefix);
        if let Err(ModelRoundError::Provider(error)) = &sent.response
            && sent.prepared.summary
            && super::super::thinking_summary::rejected(error)
        {
            self.summaries.refuse(&config);
            self.record_failed_usage(&request, &config, prefix)?;
            return Box::pin(self.run(request, local_stream, include_usage, retry, false)).await;
        }
        if let Err(ModelRoundError::Provider(error)) = &mut sent.response
            && retry.decide(
                &config,
                error,
                sent.prepared.body.as_ref(),
                sent.prepared.capability_revision.as_deref(),
            )
        {
            self.record_failed_usage(&request, &config, prefix)?;
            return Box::pin(self.run(
                request,
                local_stream,
                include_usage,
                retry,
                include_summary,
            ))
            .await;
        }
        let response = match sent.response {
            Ok(value) => value,
            Err(ModelRoundError::Provider(error))
                if include_usage && super::super::stream_usage::rejected(carrier, &error) =>
            {
                self.stream_usage.refuse(&config);
                self.record_failed_usage(&request, &config, prefix)?;
                return Box::pin(self.run(request, local_stream, false, retry, include_summary))
                    .await;
            }
            Err(ModelRoundError::Provider(error))
                if local_stream
                    && !super::super::stream_usage::rejected(carrier, &error)
                    && local_stream::falls_back(carrier, &error, &watch) =>
            {
                self.record_failed_usage(&request, &config, prefix)?;
                return self
                    .run_without_streaming(request, config.endpoint.clone())
                    .await;
            }
            Err(ModelRoundError::Provider(mut error)) => {
                self.record_failed_usage(&request, &config, prefix)?;
                self.report_failure(&config, &mut error);
                return Err(ModelRoundError::Provider(error));
            }
            Err(error) => {
                self.record_failed_usage(&request, &config, prefix)?;
                return Err(error);
            }
        };
        let result = self.complete(&request, &config, response, sent.prepared)?;
        watch.complete_tools(&result);
        Ok(result)
    }
    fn report_failure(
        &self,
        config: &super::super::ProviderRequestConfig,
        error: &mut butler_turn::btcc::ProviderRequestError,
    ) {
        if config.metadata.provider_id == "local"
            && let ProviderAuth::ApiKey(secret) = &config.auth
        {
            super::super::redact::redact_local_error(error, secret);
        }
        error.auth_type = match &config.auth {
            ProviderAuth::ChatGptPlan { .. } => Some("chatgpt_oauth".into()),
            ProviderAuth::ApiKey(_) => Some("api_key".into()),
            ProviderAuth::None => None,
        };
        error.endpoint = Some(safe_endpoint(&config.endpoint));
        error.model = Some(config.wire_model.clone());
        self.observations.failure(error);
    }
}
