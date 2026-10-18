//! Prepare the admitted wire request and its attempt trace before dispatch.
use super::*;

pub(super) struct PreparedHttp<'a> {
    pub http: butler_log::http::RequestBuilder,
    pub serialized_bytes: usize,
    pub admission: request_admission::PreparedRequestAdmission<'a>,
    pub trace: super::super::request_trace::RequestTrace,
    pub continuation: Option<super::super::continuation::LegacyProjection>,
    pub identity: Option<serde_json::Value>,
    pub thinking_binding: Option<super::super::anthropic_thinking::Binding>,
}

impl ModelProvider {
    pub(super) async fn prepare_http<'a>(
        &'a self,
        request: &ModelRoundRequest<'_>,
        config: &'a super::super::ProviderRequestConfig,
        route: (serialize::Carrier, transport::ResponseMode, &'static str),
        include_usage: bool,
    ) -> Result<PreparedHttp<'a>, ModelRoundError> {
        let (carrier, mode, api) = route;
        let serialize::PreparedBody {
            mut body,
            continuation,
            thinking_binding,
        } = serialize::body_with_visual(request, config, carrier).await?;
        if !include_usage && let Some(body) = body.as_object_mut() {
            body.remove("stream_options");
        }
        let prefix = self.prefix_history.prepare(&body, config)?.attribute(
            request.usage_attribution,
            request
                .messages
                .first()
                .map(|message| message.content.as_ref()),
        );
        let serialized = prefix.body_json(&body).map_err(|error| {
            ModelRoundError::Provider(Box::new(diagnostics::network(
                &config.metadata.provider_id,
                api,
                &error.to_string(),
            )))
        })?;
        let provider_cache_identity =
            serialize::provider_cache_identity(&body, &serialized, request, config)?;
        let serialized = Bytes::from(serialized);
        let physical_admission =
            self.admission(request, config, &body, serialized.clone(), carrier)?;
        let serialized_bytes = serialized.len();
        let http = self.round_request(config, mode, carrier, serialized);
        let http = super::super::route::cache_affinity(http, &config.auth, body);
        let trace = super::super::request_trace::RequestTrace::round(self, prefix, request).await?;
        Ok(PreparedHttp {
            http,
            serialized_bytes,
            admission: physical_admission,
            trace,
            continuation,
            thinking_binding,
            identity: provider_cache_identity,
        })
    }
}

pub(super) struct DispatchedResponse {
    pub response: Result<serde_json::Value, ModelRoundError>,
    pub prepared: PreparedResponse,
}

impl ModelProvider {
    pub(super) async fn dispatch(
        &self,
        request: &ModelRoundRequest<'_>,
        config: &super::super::ProviderRequestConfig,
        route: (serialize::Carrier, transport::ResponseMode, &'static str),
        watch: &StreamWatch<'_>,
        prepared: PreparedHttp<'_>,
    ) -> DispatchedResponse {
        let (carrier, mode, api) = route;
        let observe_request = || {
            self.observations.request(ProviderObservation {
                request_bytes: prepared.serialized_bytes,
            });
        };
        let response = transport::execute(transport::RequestExecution {
            request: prepared.http,
            provider: &config.metadata.provider_id,
            api,
            policy: config.policy,
            external: request.cancellation.clone(),
            mode: mode.for_round(round_index(request)),
            stream_observer: Some(watch),
            attempts: request
                .provider_retry_attempts
                .unwrap_or(config.retry_attempts),
            admission: request.provider_body_admission,
            physical_admission: Some(&prepared.admission),
            serialized_bytes: prepared.serialized_bytes,
            guard_start: if config.metadata.provider_id == "openai" {
                transport::GuardStart::AfterAdmission
            } else {
                transport::GuardStart::BeforeAdmission
            },
            request_observer: &observe_request,
            trace: &prepared.trace,
            clock: self.clock.as_ref(),
            quota: self.quota.as_deref(),
        })
        .await
        .inspect_err(|error| watch.discard_after(error));
        DispatchedResponse {
            response,
            prepared: PreparedResponse {
                carrier,
                continuation: prepared.continuation,
                thinking_binding: prepared.thinking_binding,
                identity: prepared.identity,
                prefix: prepared.trace.latest().unwrap_or(serde_json::Value::Null),
            },
        }
    }
}
