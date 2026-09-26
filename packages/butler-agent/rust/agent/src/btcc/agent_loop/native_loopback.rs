//! Same-actor replay, durable model-route acceptance, and physical-provider loopback.

use crate::json::JsonDocument;

use std::{sync::Arc, time::Duration};

use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::btcc::storage::{
    BtccRepositories, BtccStorage, ContextCompactionRepository, OperationResultRepository,
    TestStorageFixture, ToolJournalFinish, ToolJournalFinishStatus, ToolJournalRepository,
    ToolJournalStart,
};
use crate::btcc::{
    AgentLoop, ModelRoundError, ModelRouteEventWrite, ModelRouteRetryConfig, ModelRouteWrite,
    PortFuture, TurnModelExecutionFactory, TurnSteeringPort, TurnStore,
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

use super::ProductionAgentLoop;
use super::contracts::SteeringObservation;
use super::guided_ports::{ContextPort, GuidedInvocation, GuidedPolicyDependencies};
use super::operation_result_replay::{
    ExactResultReplaySelection, OperationResultReplayFactory, ReplayMode,
};
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

async fn server() -> (Url, tokio::task::JoinHandle<Vec<Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = Url::parse(&format!(
        "http://{}/v1/responses",
        listener.local_addr().unwrap()
    ))
    .unwrap();
    let task = tokio::spawn(async move {
        let mut bodies = Vec::new();
        for response in [
            json!({"id":"resp_1","model":"gpt-5.5","output":[{"type":"function_call","call_id":"one","name":"read_file","arguments":"{}"}]}),
            json!({"id":"resp_2","model":"gpt-5.5","output":[{"type":"message","content":[{"type":"output_text","text":"done"}]}]}),
        ] {
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
            bodies.push(serde_json::from_slice(&body).unwrap());
            let body = serde_json::to_vec(&response).unwrap();
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            socket.write_all(header.as_bytes()).await.unwrap();
            socket.write_all(&body).await.unwrap();
        }
        bodies
    });
    (endpoint, task)
}

#[tokio::test]
async fn native_provider_context_and_replay_share_one_turn_owner() {
    let fixture = TestStorageFixture::activated();
    let storage = BtccStorage::open(fixture.config("native-loopback"))
        .await
        .unwrap();
    let repositories = Arc::new(BtccRepositories::new(storage.clone(), None));
    let (turn, _) = repositories
        .load_or_admit(&crate::btcc::storage::test_prepared_turn())
        .await
        .unwrap();
    let claim = repositories.acquire_state_claim(&turn).await.unwrap();
    let route = json!({
        "schemaVersion":"butler.model-route.v1",
        "routeDigest":"a".repeat(64),
        "candidates":[{"modelRef":"openai/gpt-5.5","reasoningEffort":"medium"}],
        "retryCeiling":1,"catalogGeneration":"loopback","activeCursor":0,"consumedAttempts":[]
    });
    repositories
        .record_model_route_event(ModelRouteEventWrite {
            binding: ModelRouteWrite {
                turn_id: turn.turn_id.clone(),
                expected_revision: turn.revision,
                execution_fence: turn.execution_fence,
                claim_id: claim.claim_id.clone(),
                route: route.clone(),
            },
            event: json!({"type":"model.route.updated","roundId":"route-state","candidateIndex":0,"modelRef":"openai/gpt-5.5"}),
        })
        .await
        .unwrap();
    let mut admitted = repositories
        .find_turn(&turn.turn_id)
        .await
        .unwrap()
        .unwrap();
    admitted.model_selection = json!({
        "provider":"openai", "model":"gpt-5.5", "reasoningEffort":"medium",
        "controls":{}, "controlsHash":"hash"
    });
    admitted.context = super::test_data::turn(None, "safe_fallback").context;
    let journal = Arc::new(ToolJournalRepository::new(
        storage.clone(),
        Arc::new(|| "now".into()),
    ));
    journal
        .start(ToolJournalStart {
            turn_id: "turn".into(),
            call_id: "journal-one".into(),
            tool_name: "read_file".into(),
            raw_arguments: "{}".into(),
            arguments: json!({}),
        })
        .await
        .unwrap();
    journal
        .finish(ToolJournalFinish {
            call_id: "journal-one".into(),
            status: ToolJournalFinishStatus::Completed,
            result: Some(
                JsonDocument::from_value(&json!({"ok":true,"body":"x".repeat(20_000)})).unwrap(),
            ),
            changed_files: None,
            error_code: None,
        })
        .await
        .unwrap();

    let (endpoint, served) = server().await;
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
    let model = Arc::new(NativeModelProvider::new(
        crate::models::provider_http_client().unwrap(),
        Arc::new(Config { snapshot, endpoint }),
        Arc::new(Observations),
        catalog,
        Arc::new(Clock),
        Arc::new(Metrics),
    ));
    let policy_fixture = Fixture::new([]);
    policy_fixture
        .tool_outputs
        .lock()
        .unwrap()
        .insert("one".into(), json!({"body":"x".repeat(20_000)}));
    let context = Arc::new(NativeContextPort::new(
        Arc::new(Steering(policy_fixture.clone())),
        Some(ContextCompactionRepository::new(storage.clone())),
    ));
    let agent = ProductionAgentLoop::guided(
        model,
        Arc::new(TurnModelExecutionFactory::new(
            repositories.clone(),
            ModelRouteRetryConfig::new(0.0),
        )),
        GuidedPolicyDependencies {
            prompt: policy_fixture.clone(),
            authority: policy_fixture.clone(),
            context,
            tools: policy_fixture.clone(),
            journal: policy_fixture.clone(),
            work: policy_fixture.clone(),
            verified_image_payload: None,
            stream_observer: None,
            identity_observer: None,
        },
        None,
        Arc::new(OperationResultReplayFactory::new(
            ExactResultReplaySelection {
                mode: ReplayMode::Available,
                exact_read_capability: true,
            },
            journal.clone(),
            Arc::new(OperationResultRepository::new(storage.clone(), None)),
        )),
        policy_fixture.clone(),
        Arc::new(crate::btcc::GuidedContinuationBudgetFactory::new(
            None,
            Arc::new(|| 0),
        )),
        None,
    );
    let outcome = agent
        .run(
            &admitted,
            &claim,
            1,
            policy_fixture.as_ref(),
            &crate::btcc::NOOP_MODEL_ROUND_OBSERVER,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(outcome.content, "done");
    let bodies = served.await.unwrap();
    assert_eq!(bodies.len(), 2);
    assert!(
        bodies[1]["input"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry.to_string().contains("one"))
    );
    let delivered = journal
        .find_for_turn(turn.turn_id.clone(), "journal-one".into())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(delivered.delivery_state.as_deref(), Some("acknowledged"));
    let references = {
        let references = policy_fixture.result_references.lock().unwrap();
        references.clone()
    };
    assert_eq!(
        references[0].operation_result_call_id.as_deref(),
        Some("journal-one")
    );
    assert!(references[0].reference.is_some());
    assert!(references[0].exact_read.is_some());
    storage.close().await.unwrap();
}
