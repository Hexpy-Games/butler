//! Serving-label receipt pin through the real vector stage and recall adapter.
use super::*;
use crate::cognition::generation_vectors::compatibility;
use crate::cognition::{
    CognitionConversationSourceNotice, CognitionEmbeddingPort, EmbeddingFuture, EmbeddingIdentity,
    EmbeddingRequest, EmbeddingResult, GenerationVectorAdapter, MemoryGenerationHandle,
    MemoryGenerationTarget, RecallRequest, RecallVectorPort, RegisterConversationSourceInput,
    resolve_active_generation,
};
use crate::coordination::CognitionWaitClass;
use sha2::{Digest, Sha256};

fn native() -> EmbeddingIdentity {
    let mut identity: EmbeddingIdentity = serde_json::from_value(json!({
        "schema":"butler.native-embedding-identity.v1", "model":"Xenova/bge-m3",
        "runtime":"another-platform", "ort_wrapper_version":"upgraded", "ort_api":99,
        "runtime_build_info_sha256":"c".repeat(64), "tokenizer_runtime_version":"upgraded",
        "tokenizer_asset_sha256":"a".repeat(64), "model_asset_sha256":"b".repeat(64),
        "preprocessing":"tokenizer-json-special-tokens-checked-v1", "pooling":"cls",
        "truncation":"strict-error-over-max", "normalize":true, "max_tokens":8192,
        "dimension":1024, "version":""
    }))
    .unwrap();
    identity.version = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&identity).unwrap())
    );
    identity
}

fn js(hash: &str) -> serde_json::Value {
    let mut value = json!({
        "model":"Xenova/bge-m3", "dimension":1024, "pooling":"cls", "normalize":true,
        "version":"", "max_tokens":8192, "transformers_version":"3.8.1",
        "node_runtime_version":"24.3.0", "bun_runtime_version":"1.3.11",
        "tokenizer_asset_sha256":"a".repeat(64), "model_asset_sha256":hash
    });
    let identity = json!([
        "butler-embedding-runtime-v1",
        value["model"],
        value["transformers_version"],
        "cls",
        true,
        1024,
        8192,
        value["tokenizer_asset_sha256"],
        value["model_asset_sha256"],
        value["node_runtime_version"],
        value["bun_runtime_version"]
    ]);
    value["version"] = json!(format!(
        "{:x}",
        Sha256::digest(identity.to_string().as_bytes())
    ));
    value
}

fn manifest(handle: &MemoryGenerationHandle, identity: serde_json::Value) {
    let path = handle.root.join("manifest.json");
    let mut value: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    value["embedding"] = identity;
    std::fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
}

struct Embeddings;
impl CognitionEmbeddingPort for Embeddings {
    fn embed(&self, request: EmbeddingRequest, _: CancellationToken) -> EmbeddingFuture<'_> {
        Box::pin(async move {
            let mut vector = vec![0.0; 1024];
            vector[0] = 1.0;
            Ok(EmbeddingResult {
                embeddings: vec![vector; request.texts.len()],
                token_counts: vec![1; request.texts.len()],
                embedded_texts: Some(request.texts),
                omitted_count: Some(0),
                metadata: native(),
            })
        })
    }
}

fn request() -> RecallRequest {
    serde_json::from_value(json!({
        "cue":"paraphrase", "seedPhrases":[], "vectorQueries":[], "includeVector":true,
        "includeInternal":false,"limit":5,"scope":"all_user_sessions",
        "projectFilter":"any","projectIds":[],"sessionIds":[],"asOf":NOW,
        "runtime":{"sessionId":"chat-b","turnId":"query","currentUserMessage":"paraphrase",
            "nativeOperationId":"vector-test","projectId":"project"}
    }))
    .unwrap()
}

async fn setup(fixture: &Fixture) -> (Input, MemoryGenerationHandle) {
    let environment = CognitionPathEnvironment::default();
    let coordinator =
        Arc::new(CognitionWriteCoordinator::new(Arc::new(Facts(AtomicU64::new(1)))).unwrap());
    let generation = initialize_empty_memory_generation(
        fixture.root.clone(),
        environment.clone(),
        coordinator.clone(),
        Arc::new(|| NOW.into()),
        "test-unicode".into(),
        "test-icu".into(),
    )
    .await
    .unwrap();
    fixture.seed_canonical_outcome().await;
    std::fs::write(fixture.root.join("butler.config.json"),
        json!({"personalization":{"profiling":{"extractorModel":"provider/model","extractorReasoningEffort":"high"}}}).to_string()).unwrap();
    let registration = Arc::new(CognitionRegistrationService::new(
        environment.clone(),
        coordinator.clone(),
        Arc::new(|| NOW.into()),
    ));
    registration
        .register_conversation_source(RegisterConversationSourceInput {
            data_root: fixture.root.clone(),
            target: MemoryGenerationTarget::Active {
                expected_generation: generation.generation_id.clone(),
            },
            notice: CognitionConversationSourceNotice::Turn {
                session_id: "session".into(),
                turn_id: "turn".into(),
                outcome_generation: 1.0,
                extraction_version: "v-test".into(),
            },
            completion_job_id: Some("vector-test".into()),
            cancellation: None,
            deadline_at_epoch_ms: None,
            wait_class: CognitionWaitClass::Background,
        })
        .await
        .unwrap();
    let db = Connection::open(&generation.graph_path).unwrap();
    db.execute(
        "UPDATE memory_projection_jobs SET semantic_graph_state='{\"state\":\"complete\"}'",
        [],
    )
    .unwrap();
    db.execute("INSERT INTO memory_vector_units(unit_id,job_id,record_kind,owner_id,owner_revision,project_id,origin_kind,projection_text,source_ids_json) SELECT 'unit',j.job_id,'episode',j.episode_id,j.revision,'project','user_input','Remember this outcome',json_group_array(s.source_id) FROM memory_projection_jobs j JOIN memory_chunk_sources s ON s.episode_id=j.episode_id WHERE s.origin_kind='user_input' GROUP BY j.job_id", []).unwrap();
    let input = Input {
        data_root: fixture.root.clone(),
        environment,
        registration,
        embedding: None,
        target: None,
        coordinator,
        clock: Arc::new(|| NOW.into()),
        catchup_at: Arc::default(),
        unclean_start: Arc::new(Default::default()),
        catchup_progress: Arc::default(),
        probe: Arc::default(),
        shutdown: CancellationToken::new(),
    };
    (input, generation)
}

// test-category: format-pin
#[tokio::test]
async fn adopted_stage_pins_serving_receipts_and_refuses_other_assets() {
    let fixture = Fixture::new();
    let (input, generation) = setup(&fixture).await;
    js_table(&generation).await;
    manifest(&generation, js(&"d".repeat(64)));
    assert!(
        !super::super::vector::process(&input, &Embeddings)
            .await
            .unwrap()
    );
    let refused = resolve_active_generation(&fixture.root, &input.environment).unwrap();
    assert!(
        !input
            .probe
            .identity_refused(&refused, "memory_embedding_version_mismatch")
    );
    let db = Connection::open(&generation.graph_path).unwrap();
    let state: String = db
        .query_row("SELECT state FROM memory_vector_units", [], |r| r.get(0))
        .unwrap();
    assert_eq!(state, "failed");
    let table = lancedb::connect(generation.root.join("butler.lance").to_str().unwrap())
        .execute()
        .await
        .unwrap()
        .open_table("butler_memory")
        .execute()
        .await
        .unwrap();
    assert_eq!(table.count_rows(None).await.unwrap(), 0);
    db.execute(
        "UPDATE memory_vector_units SET state='pending',attempt_count=0",
        [],
    )
    .unwrap();
    manifest(&generation, js(&"b".repeat(64)));
    assert!(
        super::super::vector::process(&input, &Embeddings)
            .await
            .unwrap()
    );
    let current = resolve_active_generation(&fixture.root, &input.environment).unwrap();
    let receipt: String = db
        .query_row(
            "SELECT receipt_json FROM memory_vector_units WHERE state='complete'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let receipt: serde_json::Value = serde_json::from_str(&receipt).unwrap();
    assert_eq!(
        receipt["embedding_version"],
        current.embedding.as_ref().unwrap().version()
    );
    let adapter = GenerationVectorAdapter::new(
        fixture.root.clone(),
        input.environment.clone(),
        Arc::new(Embeddings),
    );
    let adapter = Arc::new(adapter);
    let hits = adapter
        .search(&current, &request(), i64::MAX)
        .await
        .unwrap();
    assert_eq!(hits.episodes.len(), 1);
    assert_eq!(
        hits.episodes[0].embedding_version,
        current.embedding.as_ref().unwrap().version()
    );
    let recall = crate::cognition::MemoryRecall::new(
        fixture.root.clone(),
        input.environment.clone(),
        Arc::new(butler_core::js_date::parse_iso_millis),
        Arc::new(Ord::cmp),
        Arc::new(|| butler_core::js_date::parse_iso_millis(NOW).unwrap()),
        2,
    )
    .with_vector_port(adapter);
    let recalled = recall.recall(request()).await.unwrap();
    assert!(
        recalled
            .results
            .iter()
            .any(|item| item.channels.iter().any(|channel| channel == "vector"))
    );
    // Recovery must validate a serving-labelled persisted receipt without embedding again.
    db.execute(
        "UPDATE memory_vector_units SET state='pending',receipt_json=NULL",
        [],
    )
    .unwrap();
    assert!(
        super::super::vector::process(&input, &NoEmbedding)
            .await
            .unwrap()
    );
    let expected = native();
    let mut upgraded = expected.clone();
    upgraded.version = "new-runtime-version".into();
    upgraded.runtime = "windows-runtime".into();
    upgraded.ort_api = 100;
    upgraded.tokenizer_runtime_version = "next".into();
    assert!(compatibility::query_identity(&expected.clone().into(), &upgraded).is_ok());
    for field in [
        "model_asset_sha256",
        "tokenizer_asset_sha256",
        "dimension",
        "pooling",
        "normalize",
        "truncation",
        "max_tokens",
        "preprocessing",
    ] {
        let mut altered = serde_json::to_value(&upgraded).unwrap();
        altered[field] = match field {
            "dimension" | "max_tokens" => json!(1),
            "normalize" => json!(false),
            _ => json!("different"),
        };
        let altered = serde_json::from_value(altered).unwrap();
        assert!(
            compatibility::query_identity(&expected.clone().into(), &altered).is_err(),
            "{field}"
        );
        assert!(
            compatibility::query_identity(current.embedding.as_ref().unwrap(), &altered).is_err(),
            "{field}"
        );
    }
    input.registration.close().await;
    native_upgrade_stage().await;
    refused_stage_idles().await;
}

async fn js_table(generation: &MemoryGenerationHandle) {
    use arrow_schema::{DataType, Field, Schema};
    let mut fields = [
        "vector_key",
        "generation",
        "record_kind",
        "owner_id",
        "owner_revision",
        "source_revision",
        "embedding_chunk_id",
        "embedding_version",
        "project_id",
        "origin_kind",
        "source_kind",
        "conversation_session_id",
        "source_observed_at",
        "source_refs_json",
        "text",
    ]
    .iter()
    .map(|name| Field::new(*name, DataType::Utf8, true))
    .collect::<Vec<_>>();
    fields.push(Field::new(
        "vector",
        DataType::FixedSizeList(Arc::new(Field::new("", DataType::Float32, true)), 1024),
        true,
    ));
    lancedb::connect(generation.root.join("butler.lance").to_str().unwrap())
        .execute()
        .await
        .unwrap()
        .create_empty_table("butler_memory", Arc::new(Schema::new(fields)))
        .execute()
        .await
        .unwrap();
}

struct NoEmbedding;
impl CognitionEmbeddingPort for NoEmbedding {
    fn embed(&self, _: EmbeddingRequest, _: CancellationToken) -> EmbeddingFuture<'_> {
        panic!("receipt recovery must not embed")
    }
}

async fn native_upgrade_stage() {
    let fixture = Fixture::new();
    let (input, generation) = setup(&fixture).await;
    let mut previous = native();
    previous.version.clear();
    previous.ort_api = 21;
    previous.runtime = "previous-runtime".into();
    previous.ort_wrapper_version = "previous-wrapper".into();
    previous.runtime_build_info_sha256 = "d".repeat(64);
    previous.tokenizer_runtime_version = "previous-tokenizer".into();
    previous.version = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&previous).unwrap())
    );
    manifest(&generation, serde_json::to_value(&previous).unwrap());
    let before = std::fs::read(generation.root.join("manifest.json")).unwrap();
    assert!(
        super::super::vector::process(&input, &Embeddings)
            .await
            .unwrap()
    );
    let current = resolve_active_generation(&fixture.root, &input.environment).unwrap();
    let adapter = GenerationVectorAdapter::new(
        fixture.root.clone(),
        input.environment.clone(),
        Arc::new(Embeddings),
    );
    let hits = adapter
        .search(&current, &request(), i64::MAX)
        .await
        .unwrap();
    assert_eq!(hits.episodes.len(), 1);
    assert_eq!(hits.episodes[0].embedding_version, previous.version);
    assert_eq!(
        std::fs::read(generation.root.join("manifest.json")).unwrap(),
        before
    );
    input.registration.close().await;
}

struct RefusingEmbeddings(MemoryGenerationHandle);
impl CognitionEmbeddingPort for RefusingEmbeddings {
    fn embed(&self, request: EmbeddingRequest, token: CancellationToken) -> EmbeddingFuture<'_> {
        Box::pin(async move {
            let mut identity = js(&"b".repeat(64));
            identity["max_tokens"] = json!(1);
            manifest(&self.0, identity);
            Embeddings.embed(request, token).await
        })
    }
}

async fn refused_stage_idles() {
    let fixture = Fixture::new();
    let (mut input, generation) = setup(&fixture).await;
    input.embedding = Some(Arc::new(RefusingEmbeddings(generation.clone())));
    // The identity changes after the claim, so the write-time gate must fail it.
    assert!(
        !super::super::vector::process(&input, input.embedding.as_ref().unwrap().as_ref())
            .await
            .unwrap()
    );
    let db = Connection::open(&generation.graph_path).unwrap();
    let state: String = db
        .query_row("SELECT state FROM memory_vector_units", [], |r| r.get(0))
        .unwrap();
    assert_eq!(state, "failed");
    assert_eq!(*input.probe.identity_diagnostic_count.lock(), 1);
    // No independent semantic/cache/catchup work remains in this idle fixture.
    db.execute("UPDATE memory_projection_windows SET state='complete'", [])
        .unwrap();
    db.execute(
        r#"UPDATE memory_projection_jobs SET hot_cache_state='{"state":"not_configured"}'"#,
        [],
    )
    .unwrap();
    let graph = crate::cognition::graph::GraphRepository::open(&generation.graph_path).unwrap();
    graph.ensure_cache_index(&input.shutdown).unwrap();
    graph.close().unwrap();
    *input.catchup_at.lock() = Some(std::time::Instant::now());
    let version: i64 = db
        .pragma_query_value(None, "data_version", |r| r.get(0))
        .unwrap();
    let before = std::fs::read(generation.root.join("manifest.json")).unwrap();
    for _ in 0..3 {
        assert!(matches!(
            super::poll(input.clone()).await.unwrap(),
            super::super::super::MemorySyncPoll::Idle
        ));
        assert_eq!(*input.probe.identity_diagnostic_count.lock(), 1);
        assert_eq!(
            db.pragma_query_value::<i64, _>(None, "data_version", |r| r.get(0))
                .unwrap(),
            version
        );
        assert_eq!(
            std::fs::read(generation.root.join("manifest.json")).unwrap(),
            before
        );
    }
    input.probe.close().await.unwrap();
    input.registration.close().await;
}
