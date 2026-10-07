//! Physical admission and transport for a prepared real model round.
use super::super::{
    local_stream::{self, StreamWatch},
    prefix_diagnostics, serialize,
};
use super::{ModelProvider, ProviderObservation, transport};
use butler_turn::btcc::{ModelRoundError, ModelRoundRequest};
use bytes::Bytes;
use std::sync::Arc;

pub(super) struct DispatchedRound {
    pub(super) response: Result<serde_json::Value, ModelRoundError>,
    pub(super) prefix: Option<serde_json::Value>,
    pub(super) stream_refused: bool,
}

pub(super) struct RoundDispatch {
    pub(super) body: serde_json::Value,
    pub(super) carrier: serialize::Carrier,
    pub(super) mode: transport::ResponseMode,
    pub(super) api: &'static str,
    pub(super) serialized: Bytes,
    pub(super) prefix: prefix_diagnostics::Prepared,
}

pub(super) struct EncodedRequest {
    pub(super) prefix: prefix_diagnostics::Prepared,
    pub(super) serialized: Bytes,
    pub(super) provider_cache_identity: Option<serde_json::Value>,
}

impl ModelProvider {
    pub(super) fn encode_request(
        &self,
        request: &ModelRoundRequest<'_>,
        config: &super::super::ProviderRequestConfig,
        body: &serde_json::Value,
        api: &str,
    ) -> Result<EncodedRequest, ModelRoundError> {
        let prefix = self.prefix_history.prepare(body, config)?.attribute(
            request.usage_attribution,
            request
                .messages
                .first()
                .map(|message| message.content.as_ref()),
        );
        let serialized = prefix.body_json(body).map_err(|error| {
            ModelRoundError::Provider(Box::new(crate::models::diagnostics::network(
                &config.metadata.provider_id,
                api,
                &error.to_string(),
            )))
        })?;
        let provider_cache_identity =
            serialize::provider_cache_identity(body, &serialized, request, config)?;
        Ok(EncodedRequest {
            prefix,
            serialized: Bytes::from(serialized),
            provider_cache_identity,
        })
    }

    pub(super) async fn dispatch_round(
        &self,
        request: &ModelRoundRequest<'_>,
        config: &Arc<super::super::ProviderRequestConfig>,
        dispatch: RoundDispatch,
    ) -> Result<DispatchedRound, ModelRoundError> {
        let RoundDispatch {
            body,
            carrier,
            mode,
            api,
            serialized,
            prefix,
        } = dispatch;
        let physical_admission =
            self.admission(request, config, &body, serialized.clone(), carrier)?;
        let serialized_bytes = serialized.len();
        let http = self.round_request(config, mode, carrier, serialized);
        let http = super::super::route::cache_affinity_ref(http, &config.auth, &body);
        self.remember_cache_request(request, config, body, &prefix, &http);
        let trace = super::super::request_trace::RequestTrace::round(self, prefix, request).await?;
        let watch = StreamWatch::new(request.stream_observer);
        let observe_request = || {
            self.keepalive.requested(
                request.cache_scope,
                request.usage_attribution.map(|a| a.turn_id.as_str()),
            );
            self.observations.request(ProviderObservation {
                request_bytes: serialized_bytes,
            });
        };
        let response = transport::execute(transport::RequestExecution {
            request: http,
            provider: &config.metadata.provider_id,
            api,
            policy: config.policy,
            external: request.cancellation.clone(),
            mode,
            stream_observer: Some(&watch),
            attempts: request
                .provider_retry_attempts
                .unwrap_or(config.retry_attempts),
            admission: request.provider_body_admission,
            physical_admission: Some(&physical_admission),
            serialized_bytes,
            guard_start: if config.metadata.provider_id == "openai" {
                transport::GuardStart::AfterAdmission
            } else {
                transport::GuardStart::BeforeAdmission
            },
            request_observer: &observe_request,
            trace: &trace,
            clock: self.clock.as_ref(),
            quota: self.quota.as_deref(),
        })
        .await
        .inspect_err(|error| watch.discard_after(error));
        let prefix = trace.latest();
        let stream_refused = matches!(&response, Err(ModelRoundError::Provider(error)) if local_stream::falls_back(carrier, error, &watch));
        Ok(DispatchedRound {
            response,
            prefix,
            stream_refused,
        })
    }
}
