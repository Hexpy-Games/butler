use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use url::Url;

use super::super::support::{Root, service_with_parts};
use super::super::*;
use crate::btcc::ModelRoundError;
use crate::locale::LocaleCollation;
use crate::models::*;

struct Config {
    metadata: ModelProviderMetadata,
    endpoint: Url,
    snapshot: Arc<ModelCatalogSnapshot>,
}
impl ProviderRequestConfigPort for Config {
    fn effective_prompt_model(&self, requested: Option<&str>) -> Result<String, ModelRoundError> {
        Ok(requested.unwrap_or(&self.metadata.model_ref).into())
    }
    fn resolve<'a>(&'a self, _: ProviderConfigRequest<'a>) -> ProviderConfigFuture<'a> {
        Box::pin(async move {
            Ok(ProviderRequestConfig {
                metadata: self.metadata.clone(),
                wire_model: self.metadata.model_id.clone(),
                endpoint: self.endpoint.clone(),
                api_shape: self.metadata.hosted_api_shape,
                auth: ProviderAuth::ApiKey("test-only".into()),
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
        Ok(self.snapshot.clone())
    }
}

struct Observations;
impl ProviderObservationSink for Observations {
    fn request(&self, _: ProviderObservation) {}
    fn response(&self, _: &str, _: &str) {}
    fn failure(&self, _: &crate::btcc::ProviderRequestError) {}
}
struct Metrics;
impl PromptUsageMetricSink for Metrics {
    fn append(&self, _: PromptUsageMetricInput<'_>) -> Result<(), ModelRoundError> {
        Ok(())
    }
}
struct Clock(AtomicI64);
impl ProviderClock for Clock {
    fn now_epoch_millis(&self) -> i64 {
        self.0.fetch_add(1, Ordering::SeqCst)
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

async fn response_server(
    body: Vec<u8>,
) -> (Url, tokio::task::JoinHandle<Vec<u8>>, Arc<AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = Url::parse(&format!(
        "http://{}/v1/responses",
        listener.local_addr().unwrap()
    ))
    .unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let accepted = requests.clone();
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        accepted.fetch_add(1, Ordering::SeqCst);
        let mut request = Vec::new();
        let mut part = [0_u8; 4096];
        loop {
            let read = socket.read(&mut part).await.unwrap();
            if read == 0 {
                break;
            }
            request.extend_from_slice(&part[..read]);
            let Some(header) = request.windows(4).position(|value| value == b"\r\n\r\n") else {
                continue;
            };
            let length = String::from_utf8_lossy(&request[..header])
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .map(str::trim)
                        .and_then(|value| value.parse::<usize>().ok())
                })
                .unwrap_or(0);
            if request.len() >= header + 4 + length {
                break;
            }
        }
        let head = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        socket.write_all(head.as_bytes()).await.unwrap();
        socket.write_all(&body).await.unwrap();
        request
    });
    (endpoint, task, requests)
}

#[tokio::test]
async fn actual_native_provider_loopback_reaches_profile_commit() {
    let text = "Please stay concise";
    let source_hash = format!("{:x}", Sha256::digest(text.as_bytes()));
    let byte_end = text.len().to_string();
    let identity = [
        "m1",
        &source_hash,
        "p1",
        "/text",
        "0",
        &byte_end,
        "profile-scalar-v1",
    ]
    .join("\0");
    let coverage_key = format!("{:x}", Sha256::digest(identity.as_bytes()));
    let evidence = format!("profile_window:{}", &coverage_key[..24]);
    let candidate = serde_json::json!({"candidates":[{
        "category":"communication","summary":"Use concise answers",
        "source_type":"explicit","confidence":"high",
        "evidence_refs":[evidence],"sensitive_domain":false
    }]})
    .to_string();
    let body = serde_json::json!({
        "id":"resp_profile","model":"gpt-5.5",
        "output":[{"type":"message","content":[{"type":"output_text","text":candidate}]}],
        "usage":{"input_tokens":3,"total_tokens":5}
    })
    .to_string()
    .into_bytes();
    let (endpoint, server, requests) = response_server(body).await;
    let (catalog, snapshot) = catalog();
    let metadata = snapshot
        .find_model_metadata(Some("openai/gpt-5.5"))
        .unwrap();
    let provider = Arc::new(NativeModelProvider::new(
        provider_http_client().unwrap(),
        Arc::new(Config {
            metadata,
            endpoint,
            snapshot,
        }),
        Arc::new(Observations),
        catalog,
        Arc::new(Clock(AtomicI64::new(1_000))),
        Arc::new(Metrics),
    ));
    let message = CanonicalProfileMessage {
        id: "m1".into(),
        session_id: "s1".into(),
        role: "user".into(),
        origin_kind: "user_input".into(),
        created_at: "2023-11-14T22:13:20.000Z".into(),
        parts: vec![CanonicalProfilePart {
            part_id: "p1".into(),
            part_index: 0.0,
            scalars: vec![CanonicalProfileScalar {
                pointer: "/text".into(),
                source_hash,
                text: text.into(),
            }],
        }],
    };
    let root = Root::new("native-provider");
    let (service, _) = service_with_parts(
        &root,
        Arc::new(Mutex::new(HashMap::from([("m1".into(), message)]))),
        provider,
    );
    service
        .set_profiling_mode(ProfilingMode::Basic)
        .await
        .unwrap();
    let cancellation = tokio_util::sync::CancellationToken::new();
    cancellation.cancel();
    let _ = service
        .capture_profile_candidates_from_transcripts_with_model(
            ProfileModelTranscriptCaptureOptions {
                cancellation,
                ..Default::default()
            },
        )
        .await;
    assert_eq!(requests.load(Ordering::SeqCst), 0);
    let result = service
        .capture_profile_candidates_from_transcripts_with_model(Default::default())
        .await
        .unwrap();
    assert_eq!(result.captured_candidate_count, 1);
    assert_eq!(result.coverage_complete_count, Some(1));
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    assert!(!server.await.unwrap().is_empty());
    service.close().await;
}
