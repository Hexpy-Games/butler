use std::sync::{Arc, Mutex};

use super::*;
use crate::models::{
    PromptUsageAttribution, PromptUsageMetricInput, PromptUsageMetricSink, ProviderPromptLifecycle,
    ProviderPromptPort, ProviderPromptRequest,
};

struct PromptConfig {
    metadata: ModelProviderMetadata,
    endpoint: Url,
    snapshot: Arc<ModelCatalogSnapshot>,
    events: Arc<Mutex<Vec<&'static str>>>,
}

impl ProviderRequestConfigPort for PromptConfig {
    fn effective_prompt_model(&self, requested: Option<&str>) -> Result<String, ModelRoundError> {
        self.events.lock().unwrap().push("model");
        Ok(requested.unwrap_or(&self.metadata.model_ref).into())
    }

    fn resolve<'a>(&'a self, _: ProviderConfigRequest<'a>) -> ProviderConfigFuture<'a> {
        self.events.lock().unwrap().push("config");
        Box::pin(async move {
            Ok(ProviderRequestConfig {
                metadata: self.metadata.clone(),
                wire_model: self.metadata.model_id.clone(),
                endpoint: self.endpoint.clone(),
                api_shape: self.metadata.hosted_api_shape,
                auth: ProviderAuth::ApiKey(String::from("test-only").into()),
                policy: ProviderRoundPolicy {
                    total: Duration::from_secs(2),
                    idle: Some(Duration::from_secs(1)),
                    retry_base_ms: 0.0,
                },
                retry_attempts: 1.0,
                prompt_cache: ProviderPromptCachePolicy::default(),
                prompt_reasoning_effort: None,
            })
        })
    }

    fn sizing_snapshot(
        &self,
        _: Option<&str>,
    ) -> Result<Arc<ModelCatalogSnapshot>, ModelRoundError> {
        self.events.lock().unwrap().push("sizing");
        Ok(Arc::clone(&self.snapshot))
    }
}

struct PromptMetrics(Arc<Mutex<Vec<&'static str>>>);

impl PromptUsageMetricSink for PromptMetrics {
    fn append_request_diagnostic(
        &self,
        _: &serde_json::Value,
        _: Option<&str>,
    ) -> Result<(), butler_turn::btcc::ModelRoundError> {
        Ok(())
    }
    fn append(&self, _: PromptUsageMetricInput<'_>) -> Result<(), ModelRoundError> {
        self.0.lock().unwrap().push("metric");
        Ok(())
    }
}

fn prompt_request<'a>(
    model: &'a str,
    cancellation: CancellationToken,
    usage: Option<&'a PromptUsageAttribution<'a>>,
) -> ProviderPromptRequest<'a> {
    ProviderPromptRequest {
        prompt: "Hello",
        model: Some(model),
        reasoning_effort: Some(&crate::models::ReasoningEffort::Medium),
        instructions: Some("System"),
        response_format: None,
        cache_scope: None,
        cache_boundary: None,
        cancellation,
        attachments: &[],
        butler_data: None,
        usage_attribution: usage,
        stream_observer: None,
        provider_retry_attempts: Some(1.0),
    }
}

// test-category: format-pin
#[tokio::test]
async fn anthropic_prompt_serializes_registered_default_output() {
    super::anthropic_schema::all_registered_tools_through_stub().await;
    let body = br#"{"content":[{"type":"text","text":"done"}],"usage":{"input_tokens":3,"output_tokens":2}}"#;
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        String::from_utf8_lossy(body)
    );
    let (endpoint, server) = server(vec![response.into_bytes()]).await;
    let events = Arc::new(Mutex::new(Vec::new()));
    let (catalog, snapshot) = catalog();
    let metadata = snapshot
        .find_model_metadata(Some("anthropic/claude-sonnet-5"))
        .unwrap();
    let provider = ModelProvider::new(
        crate::models::provider_http_client().unwrap(),
        Arc::new(PromptConfig {
            metadata,
            endpoint,
            snapshot,
            events,
        }),
        Arc::new(Observations::default()),
        catalog,
        Arc::new(TestClock::at(1_000)),
        Arc::new(PromptMetrics(Arc::new(Mutex::new(Vec::new())))),
    );
    let usage = PromptUsageAttribution {
        turn_id: None,
        phase: None,
        round_index: None,
        reasoning_effort: None,
        requested_output_tokens: None,
        budget_state: None,
        budget_state_source: None,
        prompt_sections: None,
    };
    let result = provider
        .run_prompt(
            prompt_request(
                "anthropic/claude-sonnet-5",
                CancellationToken::new(),
                Some(&usage),
            ),
            ProviderPromptLifecycle::none(),
        )
        .await
        .unwrap();
    let request = server.await.unwrap();
    assert_eq!(result.text, "done");
    let offset = request
        .windows(4)
        .position(|bytes| bytes == b"\r\n\r\n")
        .unwrap()
        + 4;
    let wire: serde_json::Value = serde_json::from_slice(&request[offset..]).unwrap();
    assert_eq!(wire["max_tokens"].as_u64(), Some(4096));
}

#[tokio::test]
async fn empty_openai_response_records_usage_before_returning_failure() {
    let body = br#"{"output":[],"usage":{"input_tokens":3,"total_tokens":5}}"#;
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        String::from_utf8_lossy(body)
    );
    let (endpoint, server) = server(vec![response.into_bytes()]).await;
    let events = Arc::new(Mutex::new(Vec::new()));
    let (catalog, snapshot) = catalog();
    let metadata = snapshot
        .find_model_metadata(Some("openai/gpt-5.5"))
        .unwrap();
    let provider = ModelProvider::new(
        crate::models::provider_http_client().unwrap(),
        Arc::new(PromptConfig {
            metadata,
            endpoint,
            snapshot,
            events: Arc::clone(&events),
        }),
        Arc::new(Observations::default()),
        catalog,
        Arc::new(TestClock::at(1_000)),
        Arc::new(PromptMetrics(Arc::clone(&events))),
    );
    let usage = PromptUsageAttribution {
        turn_id: None,
        phase: None,
        round_index: None,
        reasoning_effort: None,
        requested_output_tokens: None,
        budget_state: None,
        budget_state_source: None,
        prompt_sections: None,
    };
    let error = provider
        .run_prompt(
            prompt_request("openai/gpt-5.5", CancellationToken::new(), Some(&usage)),
            ProviderPromptLifecycle::none(),
        )
        .await
        .unwrap_err();
    server.await.unwrap();
    assert!(matches!(error, ModelRoundError::Provider(_)));
    assert!(events.lock().unwrap().ends_with(&["metric"]));
}
