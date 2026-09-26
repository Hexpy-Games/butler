use std::{
    sync::{
        Arc,
        atomic::{AtomicI64, AtomicUsize, Ordering},
    },
    time::Duration,
};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;
use url::Url;

use super::*;

mod continuation;
mod prompt;
mod serialization;
mod transport;
use crate::btcc::{
    ModelRoundError, ModelRoundMessage, ModelRoundPort, ModelRoundRequest, ModelRoundRole,
    ProviderBodyAdmissionPort, ReasoningEffort,
};
use crate::locale::LocaleCollation;
use crate::models::{
    ModelCatalog, ModelCatalogSnapshot, ModelCatalogSnapshotInput, ModelProviderMetadata,
};

struct Config {
    metadata: ModelProviderMetadata,
    endpoint: Url,
    snapshot: Arc<ModelCatalogSnapshot>,
    codex: bool,
}

impl ProviderRequestConfigPort for Config {
    fn effective_prompt_model(&self, requested: Option<&str>) -> Result<String, ModelRoundError> {
        Ok(requested.unwrap_or(&self.metadata.model_ref).to_owned())
    }

    fn resolve<'a>(&'a self, _: ProviderConfigRequest<'a>) -> ProviderConfigFuture<'a> {
        Box::pin(async move {
            Ok(ProviderRequestConfig {
                metadata: self.metadata.clone(),
                wire_model: self.metadata.model_id.clone(),
                endpoint: self.endpoint.clone(),
                api_shape: self.metadata.hosted_api_shape,
                auth: if self.codex {
                    ProviderAuth::Codex {
                        mode: ProviderAuthMode::CodexSubscription,
                        authorization: "Bearer test-only".into(),
                        account_id: "account".into(),
                        user_agent: "Butler test".into(),
                        originator: "butler".into(),
                    }
                } else {
                    ProviderAuth::ApiKey("test-only".into())
                },
                policy: ProviderRoundPolicy {
                    total: Duration::from_secs(2),
                    idle: Some(Duration::from_secs(1)),
                    retry_base_ms: 0.0,
                },
                retry_attempts: 3.0,
                prompt_cache: ProviderPromptCachePolicy::default(),
                prompt_reasoning_effort: None,
            })
        })
    }

    fn sizing_snapshot(
        &self,
        _: Option<&str>,
    ) -> Result<Arc<ModelCatalogSnapshot>, ModelRoundError> {
        Ok(Arc::clone(&self.snapshot))
    }
}

#[derive(Default)]
struct Observations {
    requests: AtomicUsize,
    responses: AtomicUsize,
    failures: AtomicUsize,
}

impl ProviderObservationSink for Observations {
    fn request(&self, _: ProviderObservation) {
        self.requests.fetch_add(1, Ordering::SeqCst);
    }
    fn response(&self, _: &str, _: &str) {
        self.responses.fetch_add(1, Ordering::SeqCst);
    }
    fn failure(&self, _: &crate::btcc::ProviderRequestError) {
        self.failures.fetch_add(1, Ordering::SeqCst);
    }
}

#[test]
fn custom_local_api_keys_are_sent_as_bearer_authorization() {
    let request = super::native::authorize(
        crate::models::provider_http_client()
            .unwrap()
            .post("http://127.0.0.1/v1/chat/completions"),
        &ProviderAuth::ApiKey("custom-local-key".into()),
        "local",
        super::serialize::Carrier::Chat { stream: false },
    )
    .build()
    .unwrap();
    assert_eq!(
        request
            .headers()
            .get(reqwest::header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok()),
        Some("Bearer custom-local-key")
    );
}

struct Metrics;

impl crate::models::PromptUsageMetricSink for Metrics {
    fn append(&self, _: crate::models::PromptUsageMetricInput<'_>) -> Result<(), ModelRoundError> {
        Ok(())
    }
}

struct Admission(AtomicUsize);

struct TestClock(AtomicI64);

impl TestClock {
    fn at(value: i64) -> Self {
        Self(AtomicI64::new(value))
    }
}

impl ProviderClock for TestClock {
    fn now_epoch_millis(&self) -> i64 {
        self.0.fetch_add(1, Ordering::SeqCst)
    }
}
impl ProviderBodyAdmissionPort for Admission {
    fn admit(
        &self,
        bytes: usize,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), ModelRoundError>> + Send + '_>>
    {
        self.0.store(bytes, Ordering::SeqCst);
        Box::pin(async { Ok(()) })
    }
}

fn catalog() -> (Arc<ModelCatalog>, Arc<ModelCatalogSnapshot>) {
    let catalog = Arc::new(ModelCatalog::new().unwrap());
    let snapshot = Arc::new(
        catalog
            .snapshot(
                ModelCatalogSnapshotInput {
                    configured_local: Vec::new(),
                    extra_models: Vec::new(),
                    registered_models: Vec::new(),
                    credential_views: Vec::new(),
                    default_model_ref: None,
                    generated_at: "now".into(),
                },
                &LocaleCollation::new("en-US").unwrap(),
            )
            .unwrap(),
    );
    (catalog, snapshot)
}

async fn server(chunks: Vec<Vec<u8>>) -> (Url, tokio::task::JoinHandle<Vec<u8>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = Url::parse(&format!(
        "http://{}/v1/responses",
        listener.local_addr().unwrap()
    ))
    .unwrap();
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut part = [0_u8; 4096];
        loop {
            let read = socket.read(&mut part).await.unwrap();
            if read == 0 {
                break;
            }
            request.extend_from_slice(&part[..read]);
            if let Some(header) = request.windows(4).position(|value| value == b"\r\n\r\n") {
                let length = String::from_utf8_lossy(&request[..header])
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(str::trim)
                            .and_then(|v| v.parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                if request.len() >= header + 4 + length {
                    break;
                }
            }
        }
        for chunk in chunks {
            socket.write_all(&chunk).await.unwrap();
            tokio::task::yield_now().await;
        }
        request
    });
    (endpoint, task)
}

fn request<'a>(
    model: &'a str,
    messages: &'a [ModelRoundMessage],
    effort: &'a ReasoningEffort,
    cancellation: CancellationToken,
    admission: Option<&'a dyn ProviderBodyAdmissionPort>,
) -> ModelRoundRequest<'a> {
    ModelRoundRequest {
        max_output_tokens: Some(64.0),
        round_id: Some("round-1"),
        model,
        messages,
        instructions: Some("Be exact."),
        tools: &[],
        tool_surface_digest: None,
        tool_choice: None,
        reasoning_effort: effort,
        cancellation,
        attachments: &[],
        image_carrier: None,
        image_capability: None,
        image_manifests: &[],
        verified_image_payload: None,
        butler_data: None,
        usage_attribution: None,
        cache_scope: None,
        stable_provider_cache_prefix: None,
        route_context: None,
        provider_retry_attempts: Some(1.0),
        route_transport_attempt_ordinal: None,
        continuation: None,
        bounded_continuation: None,
        provider_body_admission: admission,
        stream_observer: None,
        identity_observer: None,
    }
}

#[tokio::test]
async fn native_openai_json_uses_one_admitted_body_and_releases_socket() {
    let body = br#"{"id":"resp_1","model":"gpt-5.5","output":[{"type":"message","content":[{"type":"output_text","text":"done"}]}],"usage":{"input_tokens":3,"total_tokens":5}}"#;
    let head = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let (endpoint, server) = server(vec![head.into_bytes(), body.to_vec()]).await;
    let (catalog, snapshot) = catalog();
    let metadata = snapshot
        .find_model_metadata(Some("openai/gpt-5.5"))
        .unwrap();
    let observations = Arc::new(Observations::default());
    let provider = NativeModelProvider::new(
        crate::models::provider_http_client().unwrap(),
        Arc::new(Config {
            metadata,
            endpoint,
            snapshot,
            codex: false,
        }),
        observations.clone(),
        catalog,
        Arc::new(TestClock::at(1_000)),
        Arc::new(Metrics),
    );
    let messages = [ModelRoundMessage {
        role: ModelRoundRole::User,
        content: "hello".into(),
        tool_call_id: None,
        name: None,
        tool_calls: None,
        image_attachments: Vec::new(),
        provider_data: None,
        request_segment_kind: None,
        operation_result_reference: None,
        operation_result_call_id: None,
        continuation_item_id: Some("turn-item-0".into()),
    }];
    let admission = Admission(AtomicUsize::new(0));
    let result = provider
        .run_round(request(
            "openai/gpt-5.5",
            &messages,
            &ReasoningEffort::Medium,
            CancellationToken::new(),
            Some(&admission),
        ))
        .await
        .unwrap();
    let wire = server.await.unwrap();
    assert_eq!(result.text.as_deref(), Some("done"));
    assert!(admission.0.load(Ordering::SeqCst) > 0);
    assert!(String::from_utf8_lossy(&wire).contains(r#""input":"hello""#));
    assert_eq!(observations.requests.load(Ordering::SeqCst), 1);
    assert_eq!(observations.responses.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn native_hosted_sse_decodes_split_unicode_and_requires_done() {
    let body = concat!(
        "data: {\"id\":\"chat-1\",\"model\":\"qwen3.7-max\",\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"안\"}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"content\":\"녕\"},\"finish_reason\":\"stop\"}]}\r\n\r\n",
        "data: [DONE]\n\n",
    ).as_bytes().to_vec();
    let head = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let split = body
        .windows(3)
        .position(|value| value == "안".as_bytes())
        .unwrap()
        + 1;
    let (endpoint, server) = server(vec![
        head.into_bytes(),
        body[..split].to_vec(),
        body[split..].to_vec(),
    ])
    .await;
    let (catalog, snapshot) = catalog();
    let metadata = snapshot
        .find_model_metadata(Some("qwen/qwen3.7-max"))
        .unwrap();
    let observations = Arc::new(Observations::default());
    let provider = NativeModelProvider::new(
        crate::models::provider_http_client().unwrap(),
        Arc::new(Config {
            metadata,
            endpoint,
            snapshot,
            codex: false,
        }),
        observations.clone(),
        catalog,
        Arc::new(TestClock::at(1_000)),
        Arc::new(Metrics),
    );
    let messages = [ModelRoundMessage {
        role: ModelRoundRole::User,
        content: "hello".into(),
        tool_call_id: None,
        name: None,
        tool_calls: None,
        image_attachments: Vec::new(),
        provider_data: None,
        request_segment_kind: None,
        operation_result_reference: None,
        operation_result_call_id: None,
        continuation_item_id: Some("turn-item-0".into()),
    }];
    let result = provider
        .run_round(request(
            "qwen/qwen3.7-max",
            &messages,
            &ReasoningEffort::Medium,
            CancellationToken::new(),
            None,
        ))
        .await
        .unwrap();
    server.await.unwrap();
    assert_eq!(result.text.as_deref(), Some("안녕"));
    assert_eq!(
        result.provider_identity.unwrap().reported_model,
        "qwen3.7-max"
    );
    assert_eq!(observations.responses.load(Ordering::SeqCst), 1);
}

struct RejectAdmission;
impl ProviderBodyAdmissionPort for RejectAdmission {
    fn admit(
        &self,
        _: usize,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), ModelRoundError>> + Send + '_>>
    {
        Box::pin(async { Err(ModelRoundError::StablePrefix("admission-rejected".into())) })
    }
}

#[tokio::test]
async fn bounded_body_rejection_precedes_guard_and_socket_dispatch() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = Url::parse(&format!(
        "http://{}/v1/responses",
        listener.local_addr().unwrap()
    ))
    .unwrap();
    let (catalog, snapshot) = catalog();
    let metadata = snapshot
        .find_model_metadata(Some("openai/gpt-5.5"))
        .unwrap();
    let observations = Arc::new(Observations::default());
    let provider = NativeModelProvider::new(
        crate::models::provider_http_client().unwrap(),
        Arc::new(Config {
            metadata,
            endpoint,
            snapshot,
            codex: false,
        }),
        observations.clone(),
        catalog,
        Arc::new(TestClock::at(1_000)),
        Arc::new(Metrics),
    );
    let messages = [ModelRoundMessage {
        role: ModelRoundRole::User,
        content: "hello".into(),
        tool_call_id: None,
        name: None,
        tool_calls: None,
        image_attachments: Vec::new(),
        provider_data: None,
        request_segment_kind: None,
        operation_result_reference: None,
        operation_result_call_id: None,
        continuation_item_id: Some("turn-item-0".into()),
    }];
    let error = provider
        .run_round(request(
            "openai/gpt-5.5",
            &messages,
            &ReasoningEffort::Medium,
            CancellationToken::new(),
            Some(&RejectAdmission),
        ))
        .await
        .unwrap_err();
    assert!(
        matches!(error, ModelRoundError::StablePrefix(ref code) if code == "admission-rejected")
    );
    assert_eq!(observations.requests.load(Ordering::SeqCst), 0);
    assert!(
        tokio::time::timeout(Duration::from_millis(50), listener.accept())
            .await
            .is_err()
    );
}
