use super::*;
use std::{
    sync::Mutex,
    sync::atomic::{AtomicI64, AtomicUsize, Ordering},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use url::Url;

use crate::{btcc::ProviderRequestError, locale::LocaleCollation, models::*};

mod lifecycle;

struct PanicRecallVectors;
impl crate::cognition::NativeRecallVectorPort for PanicRecallVectors {
    fn search<'a>(
        &'a self,
        _: &'a crate::cognition::MemoryGenerationHandle,
        _: &'a crate::cognition::RecallRequest,
        _: i64,
    ) -> crate::cognition::RecallVectorFuture<'a> {
        panic!("embedding-none must not invoke recall vector search")
    }
}

#[derive(Default)]
struct RecallMetrics(Mutex<Vec<crate::cognition::RecallMetric>>);
impl crate::cognition::RecallMetricSink for RecallMetrics {
    fn record(&self, metric: crate::cognition::RecallMetric) {
        self.0.lock().unwrap().push(metric);
    }
}

struct Config {
    metadata: ModelProviderMetadata,
    endpoint: Url,
    snapshot: Arc<ModelCatalogSnapshot>,
}
impl ProviderRequestConfigPort for Config {
    fn effective_prompt_model(
        &self,
        requested: Option<&str>,
    ) -> Result<String, ProviderPromptError> {
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
    ) -> Result<Arc<ModelCatalogSnapshot>, ProviderPromptError> {
        Ok(self.snapshot.clone())
    }
}
struct Observations;
impl ProviderObservationSink for Observations {
    fn request(&self, _: ProviderObservation) {}
    fn response(&self, _: &str, _: &str) {}
    fn failure(&self, _: &ProviderRequestError) {}
}
struct Metrics;
impl PromptUsageMetricSink for Metrics {
    fn append(&self, _: PromptUsageMetricInput<'_>) -> Result<(), ProviderPromptError> {
        Ok(())
    }
}
struct Clock(AtomicI64);
impl ProviderClock for Clock {
    fn now_epoch_millis(&self) -> i64 {
        self.0.fetch_add(1, Ordering::SeqCst)
    }
}

async fn response_server(
    body: Vec<u8>,
) -> (Url, tokio::task::JoinHandle<Vec<Vec<u8>>>, Arc<AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = Url::parse(&format!(
        "http://{}/v1/responses",
        listener.local_addr().unwrap()
    ))
    .unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let counter = requests.clone();
    let task = tokio::spawn(async move {
        let mut captured = Vec::new();
        while let Ok(Ok((mut socket, _))) =
            tokio::time::timeout(Duration::from_secs(3), listener.accept()).await
        {
            counter.fetch_add(1, Ordering::SeqCst);
            let mut request = Vec::new();
            let mut part = [0u8; 4096];
            loop {
                let read = socket.read(&mut part).await.unwrap();
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&part[..read]);
                let Some(head) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n") else {
                    continue;
                };
                let length = String::from_utf8_lossy(&request[..head])
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .and_then(|n| n.trim().parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                if request.len() >= head + 4 + length {
                    break;
                }
            }
            let wire = String::from_utf8_lossy(&request);
            let reply = if wire.contains("\\\"targets\\\"") {
                let binding = if wire.contains("f0c0p0") {
                    json!({"decisions":[{"target":"n0","candidate":"n0c0",
                        "span":null,"support":["n0u0","n0c0h"]},
                        {"target":"f0","candidate":"f0c0","span":"f0c0p0",
                        "support":["f0u0","f0c0h"]}]})
                } else {
                    json!({"decisions":[{"target":"n0","candidate":"n0c0",
                        "span":null,"support":["n0u0","n0c0h"]}]})
                }
                .to_string();
                json!({"id":"resp_binding","model":"gpt-5.5","output":[{"type":"message",
                    "content":[{"type":"output_text","text":binding}]}],
                    "usage":{"input_tokens":3,"total_tokens":5}})
                .to_string()
                .into_bytes()
            } else if wire.contains("Straße likes coffee") {
                let meaning = json!({"status":"processed",
                    "entities":[{"name":"Straße","evidence":[0]}],
                    "items":[{"kind":"change","subject":0,"field":"preference",
                        "old":"tea","new":"coffee","evidence":[0]}],
                    "attributes":[]})
                .to_string();
                json!({"id":"resp_correction","model":"gpt-5.5",
                    "output":[{"type":"message","content":[{"type":"output_text",
                        "text":meaning}]}],"usage":{"input_tokens":3,"total_tokens":5}})
                .to_string()
                .into_bytes()
            } else {
                body.clone()
            };
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",reply.len()).as_bytes()).await.unwrap();
            socket.write_all(&reply).await.unwrap();
            captured.push(request);
        }
        captured
    });
    (endpoint, task, requests)
}

#[tokio::test]
async fn actual_native_provider_applies_registered_semantic_window() {
    let meaning=serde_json::json!({"status":"processed","entities":[{"name":"Straße","evidence":[0]}],"items":[{"kind":"preference","subject":0,"text":"Straße likes tea","evidence":[0]}],"attributes":[]}).to_string();
    let body=serde_json::json!({"id":"resp_cognition","model":"gpt-5.5","output":[{"type":"message","content":[{"type":"output_text","text":meaning}]}],"usage":{"input_tokens":3,"total_tokens":5}}).to_string().into_bytes();
    let (endpoint, server, requests) = response_server(body).await;
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
    let fixture = Fixture::new("native-semantic");
    fixture.seed_with_text("Straße likes tea 🙂").await;
    let facts = Arc::new(Facts::new());
    let coordinator = Arc::new(CognitionWriteCoordinator::new(facts.clone()).unwrap());
    let service = CognitionRegistrationService::with_projection(
        CognitionPathEnvironment::default(),
        coordinator,
        Arc::new(|| NOW.into()),
        provider,
        Arc::new(NoVectors),
        facts,
    );
    let ConversationRegistrationOutcome::Registered(progress) = service
        .register_conversation_source(fixture.input("native-semantic"))
        .await
        .unwrap()
    else {
        panic!("expected registration")
    };
    let input = ProjectSemanticWindowInput {
        data_root: fixture.root.clone(),
        target: MemoryGenerationTarget::Active {
            expected_generation: GENERATION.into(),
        },
        job_id: progress.job_id.clone(),
        notice: fixture.input("native-semantic").notice.into(),
        cancellation: None,
        deadline_at_epoch_ms: None,
        wait_class: CognitionWaitClass::Background,
    };
    let result = service
        .project_semantic_window(input)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result.semantic_graph["state"], "partial");
    fixture
        .additional_turn("turn2", "Straße likes coffee now")
        .await;
    let second_notice = fixture.input_turn("native-semantic-2", "turn2");
    let ConversationRegistrationOutcome::Registered(second) = service
        .register_conversation_source(second_notice.clone())
        .await
        .unwrap()
    else {
        panic!("expected second registration")
    };
    let second_projection = service
        .project_semantic_window(ProjectSemanticWindowInput {
            data_root: fixture.root.clone(),
            target: MemoryGenerationTarget::Active {
                expected_generation: GENERATION.into(),
            },
            job_id: second.job_id,
            notice: second_notice.notice.into(),
            cancellation: None,
            deadline_at_epoch_ms: None,
            wait_class: CognitionWaitClass::Background,
        })
        .await
        .unwrap()
        .unwrap();
    assert_eq!(second_projection.semantic_graph["state"], "partial");
    service.close().await;
    let provider_requests = server.await.unwrap();
    assert!(requests.load(Ordering::SeqCst) >= 2);
    assert!(String::from_utf8_lossy(&provider_requests[0]).contains("memory_meaning_v4"));
    let graph = Connection::open(fixture.graph_path()).unwrap();
    let row: (String, Option<String>) = graph
        .query_row(
            "SELECT state,owner_nonce FROM memory_projection_windows ORDER BY ordinal LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(row, ("complete".into(), None));
    let commits: i64 = graph
        .query_row("SELECT COUNT(*) FROM memory_meaning_commits", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(commits, 2);
    let corrections: i64 = graph
        .query_row(
            "SELECT COUNT(*) FROM edges WHERE rel_type='supersedes' AND status='active'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        corrections, 1,
        "the second provider window must bind a real correction"
    );

    let compare = Arc::new(LocaleCollation::new("en-US").unwrap());
    let metrics = Arc::new(RecallMetrics::default());
    let reader = crate::cognition::NativeMemoryRecall::new(
        fixture.root.clone(),
        CognitionPathEnvironment::default(),
        Arc::new(crate::js_date::parse_iso_millis),
        Arc::new(move |left, right| compare.compare(left, right)),
        Arc::new(|| crate::js_date::parse_iso_millis("2026-09-19T00:00:00.000Z").unwrap()),
        2,
    )
    .with_vector_port(Arc::new(PanicRecallVectors))
    .with_metric_sink(metrics.clone());
    let request: crate::cognition::RecallRequest = serde_json::from_value(json!({
        "cue":"Straße","seedPhrases":[],"vectorQueries":[],"includeVector":false,
        "includeInternal":false,"limit":5,"scope":"current_session",
        "projectFilter":"any","projectIds":[],"sessionIds":[],
        "asOf":"2026-09-19T00:00:00.000Z",
        "runtime":{"sessionId":"session","turnId":"turn","currentUserMessage":"find Straße",
            "nativeOperationId":"recall-native","projectId":"project"}
    }))
    .unwrap();
    let recall = reader.recall(request.clone()).await.unwrap();
    assert!(!recall.results.is_empty(), "{recall:?}");
    {
        let recorded = metrics.0.lock().unwrap();
        assert!(matches!(
            recorded.first(),
            Some(crate::cognition::RecallMetric::Stage {
                name: "recall_v2_graph_read_ppr",
                ..
            })
        ));
        assert!(recorded.iter().any(|metric| matches!(
            metric,
            crate::cognition::RecallMetric::Stage {
                name: "recall_v2_source_hydration",
                ..
            }
        )));
        assert!(recorded.iter().any(|metric| matches!(metric,
        crate::cognition::RecallMetric::CandidateRanking { episode_sha256,
            native_operation_sha256, .. } if episode_sha256.len() == 64
                && native_operation_sha256.len() == 64
                && !episode_sha256.contains("episode"))));
        assert!(matches!(
            recorded.last(),
            Some(crate::cognition::RecallMetric::ReturnedRanking { .. })
        ));
    }
    let evidence = &recall.results[0].evidence[0];
    assert!(evidence.source_ref.starts_with("memory-source:v2:"));
    assert!(evidence.excerpt.contains("Straße"));
    let canonical =
        crate::conversation::ConversationSourceReader::open(&fixture.canonical_path()).unwrap();
    let original = canonical
        .read_message(evidence.conversation_message_id.as_deref().unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(
        original.message.id,
        evidence.conversation_message_id.as_deref().unwrap()
    );
    canonical.close().unwrap();
    let mut vector_request = request.clone();
    vector_request.include_vector = true;
    let no_embedding = reader.recall(vector_request).await.unwrap();
    assert!(!no_embedding.results.is_empty());
    assert_eq!(
        no_embedding.coverage.vectors.state,
        crate::cognition::recall::RecallCoverageState::Unavailable
    );
    assert_eq!(
        no_embedding.coverage.vectors.codes,
        ["embedding_not_configured"]
    );
    let mut paged = request.clone();
    paged.limit = 1;
    paged.runtime.native_operation_id = "recall-page-one".into();
    let first_page = reader.recall(paged.clone()).await.unwrap();
    assert_eq!(first_page.results.len(), 1, "{first_page:?}");
    assert_eq!(
        first_page.results[0].evidence[0]
            .conversation_message_id
            .as_deref(),
        Some("request"),
        "the exact Straße cue retains the source's raw-match priority"
    );
    let cursor = first_page
        .next_cursor
        .clone()
        .expect("two source windows need continuation");
    paged.cursor = Some(cursor);
    paged.runtime.turn_id = "later-turn".into();
    paged.runtime.native_operation_id = "recall-page-two".into();
    let next_page = reader.recall(paged.clone()).await.unwrap();
    assert_eq!(next_page.results.len(), 1, "{next_page:?}");
    assert_eq!(
        next_page.results[0].evidence[0]
            .conversation_message_id
            .as_deref(),
        Some("request-turn2")
    );
    let mut correction_cue = request.clone();
    correction_cue.cue = "coffee".into();
    correction_cue.runtime.native_operation_id = "recall-correction".into();
    let current = reader.recall(correction_cue).await.unwrap();
    assert_eq!(
        current.results[0].evidence[0]
            .conversation_message_id
            .as_deref(),
        Some("request-turn2"),
        "the specific cue must retrieve the corrected current source"
    );
    assert_ne!(
        first_page.results[0].episode_ref,
        next_page.results[0].episode_ref
    );
    assert!(next_page.next_cursor.is_none());
    paged.cursor = None;
    let before_revision_change = reader.recall(paged.clone()).await.unwrap();
    paged.cursor = before_revision_change.next_cursor;
    graph
        .execute(
            "UPDATE memory_state SET value='changed-revision' WHERE key='graph_revision'",
            [],
        )
        .unwrap();
    assert_eq!(
        reader.recall(paged.clone()).await.unwrap_err().code,
        "stale_cursor"
    );
    reader.close().await;
    let compare = Arc::new(LocaleCollation::new("en-US").unwrap());
    let reopened = crate::cognition::NativeMemoryRecall::new(
        fixture.root.clone(),
        CognitionPathEnvironment::default(),
        Arc::new(crate::js_date::parse_iso_millis),
        Arc::new(move |left, right| compare.compare(left, right)),
        Arc::new(|| crate::js_date::parse_iso_millis("2026-09-19T00:00:00.000Z").unwrap()),
        2,
    );
    paged.cursor = None;
    let after_reopen = reopened.recall(paged).await.unwrap();
    assert_eq!(
        after_reopen.results[0].episode_ref,
        first_page.results[0].episode_ref
    );
    reopened.close().await;
    lifecycle::prove(fixture.root.clone(), request).await;
}
