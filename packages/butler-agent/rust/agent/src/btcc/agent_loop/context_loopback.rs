//! Real Context summary producer with the native provider and full BTCC store.

use std::{sync::Arc, time::Duration};

use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::btcc::model_route::{ModelExecutionFactory, ModelExecutionInput};
use crate::btcc::storage::{
    BtccRepositories, BtccStorage, ContextCompactionRepository, TestStorageFixture,
};
use crate::btcc::{
    ContextMessages, ContextPort, ContextProjectionInput, GuidedContinuationBudgetFactory,
    ModelRoundError, ModelRoundMessage, ModelRoundPort, ModelRoundRequest, ModelRouteRetryConfig,
    PortFuture, SteeringObservation, TurnContinuationBudgetLimits, TurnModelExecutionFactory,
    TurnSteeringPort, TurnStore,
};
use crate::context::NativeContextPort;
use crate::locale::LocaleCollation;
use crate::models::{
    ModelCatalog, ModelCatalogSnapshot, ModelCatalogSnapshotInput, NativeModelProvider,
    PromptUsageMetricInput, PromptUsageMetricSink, ProviderAuth, ProviderClock,
    ProviderConfigFuture, ProviderConfigRequest, ProviderObservation, ProviderObservationSink,
    ProviderPromptCachePolicy, ProviderRequestConfig, ProviderRequestConfigPort,
    ProviderRoundPolicy,
};

use super::guided_ports::GuidedInvocation;
use super::test_support::Fixture;

struct Config {
    snapshot: Arc<ModelCatalogSnapshot>,
    endpoint: Url,
}

impl ProviderRequestConfigPort for Config {
    fn effective_prompt_model(&self, requested: Option<&str>) -> Result<String, ModelRoundError> {
        Ok(requested.unwrap_or("openai/gpt-5.5").into())
    }

    fn resolve<'a>(&'a self, _: ProviderConfigRequest<'a>) -> ProviderConfigFuture<'a> {
        Box::pin(async move {
            let metadata = self
                .snapshot
                .find_model_metadata(Some("openai/gpt-5.5"))
                .unwrap();
            Ok(ProviderRequestConfig {
                wire_model: metadata.model_id.clone(),
                api_shape: metadata.hosted_api_shape,
                metadata,
                endpoint: self.endpoint.clone(),
                auth: ProviderAuth::ApiKey("loopback-only".into()),
                policy: ProviderRoundPolicy {
                    total: Duration::from_secs(3),
                    idle: Some(Duration::from_secs(2)),
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

struct Clock;
impl ProviderClock for Clock {
    fn now_epoch_millis(&self) -> i64 {
        1_000
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

struct Steering(Arc<Fixture>);
impl TurnSteeringPort for Steering {
    fn observe<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
    ) -> PortFuture<'a, Vec<SteeringObservation>> {
        self.0.steering(invocation)
    }
}

async fn server(
    fail_summary: bool,
) -> (
    Url,
    Arc<Mutex<Vec<(Value, usize)>>>,
    tokio::task::JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = Url::parse(&format!(
        "http://{}/v1/responses",
        listener.local_addr().unwrap()
    ))
    .unwrap();
    let bodies = Arc::new(Mutex::new(Vec::new()));
    let captured = bodies.clone();
    let task = tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut chunk = [0u8; 4096];
            let body = loop {
                let read = socket.read(&mut chunk).await.unwrap();
                assert!(read > 0);
                request.extend_from_slice(&chunk[..read]);
                if let Some(split) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                    let length = String::from_utf8_lossy(&request[..split])
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .and_then(|value| value.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if request.len() >= split + 4 + length {
                        break request[split + 4..split + 4 + length].to_vec();
                    }
                }
            };
            let value: Value = serde_json::from_slice(&body).unwrap();
            let is_summary = value.to_string().contains("Integrate the previous summary")
                || value.to_string().contains("Shorten this working summary");
            captured.lock().await.push((value, body.len()));
            if fail_summary && is_summary {
                let bytes = b"{\"error\":{\"message\":\"summary unavailable\"}}";
                let header = format!(
                    "HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    bytes.len()
                );
                socket.write_all(header.as_bytes()).await.unwrap();
                socket.write_all(bytes).await.unwrap();
                continue;
            }
            let response = json!({"id":"resp_loop","model":"gpt-5.5","output":[
                {"type":"message","content":[{"type":"output_text",
                    "text":if is_summary { "short working summary" } else { "done" }}]}
            ]});
            let bytes = serde_json::to_vec(&response).unwrap();
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                bytes.len()
            );
            socket.write_all(header.as_bytes()).await.unwrap();
            socket.write_all(&bytes).await.unwrap();
        }
    });
    (endpoint, bodies, task)
}

fn provider(endpoint: Url) -> Arc<NativeModelProvider> {
    let catalog = Arc::new(ModelCatalog::new().unwrap());
    let snapshot = Arc::new(
        catalog
            .snapshot(
                ModelCatalogSnapshotInput {
                    configured_local: vec![],
                    extra_models: vec![],
                    registered_models: vec![],
                    credential_views: vec![],
                    default_model_ref: None,
                    generated_at: "now".into(),
                },
                &LocaleCollation::new("en-US").unwrap(),
            )
            .unwrap(),
    );
    Arc::new(NativeModelProvider::new(
        crate::models::provider_http_client().unwrap(),
        Arc::new(Config { snapshot, endpoint }),
        Arc::new(Observations),
        catalog,
        Arc::new(Clock),
        Arc::new(Metrics),
    ))
}

fn limits() -> TurnContinuationBudgetLimits {
    TurnContinuationBudgetLimits {
        max_model_requests: 5,
        max_tool_rounds: 5,
        max_model_facing_bytes: 4_000,
        max_cumulative_model_facing_bytes: 20_000,
        max_output_bytes: 20_000,
        max_elapsed_ms: 100_000,
        max_idle_ms: 100_000,
        extensions: Default::default(),
    }
}

#[tokio::test]
async fn native_summary_persists_and_reopens_with_physical_request_admission() {
    let fixture = TestStorageFixture::activated();
    let storage = BtccStorage::open(fixture.config("context-native-first"))
        .await
        .unwrap();
    let repositories = Arc::new(BtccRepositories::new(storage.clone(), Some(limits())));
    let (mut turn, _) = repositories
        .load_or_admit(&crate::btcc::storage::test_prepared_turn())
        .await
        .unwrap();
    let claim = repositories.acquire_state_claim(&turn).await.unwrap();
    turn.model_selection = json!({"provider":"openai","model":"gpt-5.5",
        "reasoningEffort":"medium","controls":{},"controlsHash":"hash"});
    let started = turn.continuation_budget.as_ref().unwrap()["startedAtMs"]
        .as_u64()
        .unwrap();
    let budget_factory = GuidedContinuationBudgetFactory::new(
        Some(repositories.clone()),
        Arc::new(move || started + 1),
    );
    let budget = budget_factory.bind(&turn, &claim).unwrap().unwrap();
    let (endpoint, bodies, serving) = server(false).await;
    let model = provider(endpoint);
    let progress = Fixture::new([]);
    let cancellation = CancellationToken::new();
    let execution_factory =
        TurnModelExecutionFactory::new(repositories.clone(), ModelRouteRetryConfig::new(0.0));
    let execution = execution_factory
        .create(ModelExecutionInput {
            source_revision: crate::btcc::model_route::GuidedSourceRevision::from_turn(&turn),
            turn: &turn,
            claim: &claim,
            progress: progress.as_ref(),
            model_round_observer: &crate::btcc::NOOP_MODEL_ROUND_OBSERVER,
            cancellation: cancellation.clone(),
            base: model.as_ref(),
        })
        .await
        .unwrap();
    let invocation = GuidedInvocation {
        turn: &turn,
        claim: &claim,
        recovery_attempt: 1,
        progress: progress.as_ref(),
        cancellation: &cancellation,
        model_execution: execution.as_ref(),
        operation_results: None,
    };
    let context = NativeContextPort::new(
        Arc::new(Steering(progress.clone())),
        Some(ContextCompactionRepository::new(storage.clone())),
    );
    let owner = context.begin_turn(invocation, Some(budget)).await.unwrap();
    let mut first = ModelRoundMessage::user("request".into(), None);
    first.continuation_item_id = Some("turn-item-0".into());
    let mut history =
        ModelRoundMessage::user(format!("HISTORY_SENTINEL {}", "x".repeat(12_000)), None);
    history.continuation_item_id = Some("turn-item-1".into());
    let mut latest = ModelRoundMessage::user("latest".into(), Some("current_user_request".into()));
    latest.continuation_item_id = Some("turn-item-2".into());
    let semantic = [first.clone(), history, latest.clone()];
    let transport = [first, latest];
    let model_ref = execution.active_model_ref();
    let projection = owner
        .project(
            invocation,
            ContextProjectionInput {
                round_id: "round-1",
                response_item_id: "turn-item-4",
                semantic_messages: &semantic,
                transport_messages: &transport,
                model_ref: &model_ref,
                instructions: None,
                tools: &[],
                tool_choice: None,
                attachments: &[],
                butler_data: None,
                max_model_facing_bytes: 4_000,
            },
        )
        .await
        .unwrap();
    assert!(projection.requires_rebase);
    assert!(projection.recheck_steering_on_rebase);
    let ContextMessages::Owned(projected) = &projection.messages else {
        panic!("summary must materialize")
    };
    assert!(
        projected
            .iter()
            .any(|message| message.content.contains("short working summary"))
    );
    let envelope = serde_json::to_value(projection.bounded_continuation.as_ref().unwrap()).unwrap();
    let reasoning = execution.selected_reasoning_effort();
    let response = execution
        .base()
        .run_round(ModelRoundRequest {
            max_output_tokens: None,
            round_id: Some("round-1"),
            model: &model_ref,
            messages: projected,
            instructions: None,
            tools: &[],
            tool_surface_digest: None,
            tool_choice: None,
            reasoning_effort: &reasoning,
            cancellation: cancellation.clone(),
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
            bounded_continuation: Some(&envelope),
            provider_body_admission: projection.provider_body_admission.as_deref(),
            stream_observer: None,
            identity_observer: None,
        })
        .await
        .unwrap();
    assert_eq!(response.text.as_deref(), Some("done"));
    let captured = bodies.lock().await;
    let summary_requests = captured
        .iter()
        .filter(|(body, _)| body.to_string().contains("Integrate the previous summary"))
        .count();
    assert!(summary_requests > 0);
    assert!(
        captured[..captured.len() - 1]
            .iter()
            .all(|(body, _)| body.get("tools").is_none())
    );
    let (outer, physical_bytes) = captured.last().unwrap();
    assert!(outer.to_string().contains("short working summary"));
    assert!(!outer.to_string().contains("HISTORY_SENTINEL"));
    let physical_bytes = *physical_bytes;
    let call_count = captured.len();
    drop(captured);
    let persisted = repositories
        .find_turn(&turn.turn_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        persisted.continuation_budget.unwrap()["admittedRequests"][0]["modelFacingBytes"],
        physical_bytes
    );
    assert_eq!(
        ContextCompactionRepository::new(storage.clone())
            .load(&turn.turn_id)
            .await
            .unwrap()
            .len(),
        1
    );
    drop(owner);
    storage.close().await.unwrap();

    let reopened = BtccStorage::open(fixture.config("context-native-reopen"))
        .await
        .unwrap();
    let reopened_context = NativeContextPort::new(
        Arc::new(Steering(progress.clone())),
        Some(ContextCompactionRepository::new(reopened.clone())),
    );
    let owner = reopened_context.begin_turn(invocation, None).await.unwrap();
    let reused = owner
        .project(
            invocation,
            ContextProjectionInput {
                round_id: "round-2",
                response_item_id: "turn-item-5",
                semantic_messages: &semantic,
                transport_messages: &transport,
                model_ref: &model_ref,
                instructions: None,
                tools: &[],
                tool_choice: None,
                attachments: &[],
                butler_data: None,
                max_model_facing_bytes: 4_000,
            },
        )
        .await
        .unwrap();
    assert!(matches!(reused.messages, ContextMessages::Owned(_)));
    assert_eq!(bodies.lock().await.len(), call_count);
    drop(owner);
    reopened.close().await.unwrap();
    serving.abort();
    drop(execution);
}

mod failure;
mod selection;
