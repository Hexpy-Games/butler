use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::Value;

use super::*;
use butler_core::locale::LocaleCollation;
use butler_turn::conversation::{
    AgentConversationStore, ConversationAdmissionTurn, ConversationAdmissionTurnInput,
    ConversationEnvelope, ConversationOriginEvidence, ConversationOriginFacts,
    ConversationStoreConfig, DurableSessionBinding, classify_conversation_origin,
};

// test-category: race
#[tokio::test]
async fn canonical_completion_publishes_one_observation_and_one_queue_job_then_drains() {
    let root = std::env::temp_dir().join(format!("butler-completion-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(root.join("runtime")).unwrap();
    let clock = Arc::new(crate::host::SystemIdentity);
    let collation = Arc::new(LocaleCollation::new("en").unwrap());
    let store = AgentConversationStore::open(ConversationStoreConfig {
        path: root.join("runtime/conversation-store.sqlite"),
        identity_clock: clock.clone(),
        collation: collation.clone(),
    })
    .await
    .unwrap();
    let graph = busy_graph(&root);
    let embedding = Arc::new(crate::host::EmbeddingOwner::new(root.clone()).unwrap());
    embedding.enable();
    let observer = Arc::new(
        ConversationObserver::new(
            &root.clone(),
            &CognitionPathEnvironment::default(),
            clock,
            Arc::new(butler_runtime::operations::MetricFiles::new(root.clone())),
            Some(embedding.clone()),
        )
        .unwrap(),
    );
    let origin = classify_conversation_origin(
        collation.as_ref(),
        ConversationOriginFacts {
            reference: Some("app:event-1".into()),
            public_ingress: true,
            internal_control: false,
            evidence_available: true,
            evidence: vec![ConversationOriginEvidence {
                reference: "app:event-1".into(),
                kind: "app_ingress".into(),
                sha256: None,
            }],
        },
    );
    let turn = ConversationAdmissionTurn::begin(ConversationAdmissionTurnInput {
        store: store.clone(),
        binding: DurableSessionBinding {
            session_id: "runtime-first-user".into(),
            project_id: None,
            role: "primary".into(),
            model_ref: "openai/test".into(),
        },
        envelope: ConversationEnvelope {
            transport: "app".into(),
            event_id: "event-1".into(),
            message_text: "original user message".into(),
            content_parts: None,
            hook_context: None,
            resume: false,
        },
        turn_id: "ct_first_user".into(),
        timestamp: "2026-09-19T00:00:00.000Z".into(),
        origin,
        observer: observer.clone(),
    })
    .await
    .unwrap();
    let started = Instant::now();
    let first = tokio::time::timeout(Duration::from_millis(100), turn.admit_inbound()).await;
    let first_ms = started.elapsed().as_secs_f64() * 1_000.0;
    // Give the probe time to enter SQLite, then exercise the shared observer
    // from another session while the exclusive lock is still held.
    tokio::time::sleep(Duration::from_millis(100)).await;
    let started = Instant::now();
    let second = tokio::time::timeout(
        Duration::from_millis(100),
        observer.admission_metric(AdmissionMetric {
            session_id: "runtime-second-user".into(),
            session_role: "primary".into(),
            source: AdmissionSource::Gateway,
            event_kind: "inbound.accepted".into(),
            admitted: true,
            class_name: "user",
            reason: "public_ingress",
        }),
    )
    .await;
    let second_ms = started.elapsed().as_secs_f64() * 1_000.0;
    graph.execute_batch("ROLLBACK").unwrap();
    drop(graph);
    eprintln!("BUSY-PREWARM first_admission_ms={first_ms:.3} second_admission_ms={second_ms:.3}");
    first
        .expect("first admission must not wait on the probe")
        .unwrap();
    second
        .expect("another session must not wait on the probe")
        .unwrap();
    turn.admit_final("original assistant answer", "final-1")
        .await
        .unwrap();
    // Occupy the observer lane on a durable write. Finalizing the answer must
    // not wait for it: the publication follows once the lane is free.
    let metrics = root.join("metrics");
    std::fs::create_dir_all(&metrics).unwrap();
    let lane_lock = std::fs::File::options()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(metrics.join(".operational-events.jsonl.append.lock"))
        .unwrap();
    lane_lock.try_lock().unwrap();
    let busy = tokio::spawn({
        let observer = observer.clone();
        async move {
            observer
                .admission_metric(AdmissionMetric {
                    session_id: "runtime-second-user".into(),
                    session_role: "primary".into(),
                    source: AdmissionSource::Gateway,
                    event_kind: "inbound.accepted".into(),
                    admitted: true,
                    class_name: "user",
                    reason: "public_ingress",
                })
                .await
        }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    let finalized = tokio::time::timeout(
        Duration::from_secs(5),
        turn.finalize("complete", "2026-09-19T00:00:01.000Z"),
    )
    .await;
    lane_lock.unlock().unwrap();
    busy.await.unwrap().unwrap();
    finalized
        .expect("the final answer must not wait on memory publication")
        .unwrap();
    let canonical = store
        .read_turn_outcome("ct_first_user")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(canonical.generation, 1.0);
    observer.close().await.unwrap();
    embedding.close().await.unwrap();
    store.close().await.unwrap();

    let directory = root.join("cognition/memory/queue/completion-observations");
    let paths = std::fs::read_dir(directory)
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(paths.len(), 1);
    let notice: Value =
        serde_json::from_str(&std::fs::read_to_string(paths[0].path()).unwrap()).unwrap();
    assert_eq!(notice["scope"], "global");
    assert_eq!(notice["conversation_turn_id"], "ct_first_user");
    assert_eq!(notice["outcome_generation"], 1);
    assert!(notice.get("original user message").is_none());
    let queue = std::fs::read_to_string(root.join("cognition/memory/queue/sync.jsonl")).unwrap();
    let lines: Vec<_> = queue.lines().collect();
    assert_eq!(lines.len(), 1);
    let job: Value = serde_json::from_str(lines[0]).unwrap();
    assert_eq!(job["job_id"], notice["job_id"]);
    assert_eq!(
        job["source"]["session_id"],
        notice["conversation_session_id"]
    );
    assert_eq!(job["source"]["turn_id"], "ct_first_user");
    assert!(!queue.contains("original user message"));
    assert!(!queue.contains("original assistant answer"));
    std::fs::remove_dir_all(root).unwrap();
}

fn busy_graph(root: &Path) -> butler_platform::sqlite::Connection {
    use butler_memory::cognition::{EmbeddingIdentity, GenerationVectorAdapter};
    use serde_json::json;
    use sha2::{Digest, Sha256};

    let id = uuid::Uuid::new_v4().to_string();
    let memory = root.join("cognition/memory");
    let generation = memory.join("generations").join(&id);
    std::fs::create_dir_all(&generation).unwrap();
    let mut identity: EmbeddingIdentity = serde_json::from_value(json!({
        "schema": "butler.native-embedding-identity.v1", "model": "model", "runtime": "ort",
        "ort_wrapper_version": "2", "ort_api": 22, "runtime_build_info_sha256": "a".repeat(64),
        "tokenizer_runtime_version": "1", "tokenizer_asset_sha256": "b".repeat(64),
        "model_asset_sha256": "c".repeat(64), "preprocessing": "tokenizer-json-special-tokens-checked-v1",
        "pooling": "cls", "truncation": "strict-error-over-max", "normalize": true,
        "max_tokens": 8192, "dimension": 1024, "version": ""
    })).unwrap();
    identity.version = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&identity).unwrap())
    );
    std::fs::write(
        memory.join("active-generation.json"),
        json!({
            "schema": "butler.memory-active-generation.v2", "generation_id": id,
            "projection_mode": "running"
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(
        generation.join("manifest.json"),
        json!({
            "schema": "butler.memory-generation.v2", "generation_id": id,
            "format": "v2", "state": "active", "embedding": identity
        })
        .to_string(),
    )
    .unwrap();
    let path = generation.join("graph.sqlite");
    let graph = butler_platform::sqlite::open(&path).unwrap();
    graph
        .execute_batch(
            "PRAGMA journal_mode=DELETE;
        CREATE TABLE memory_state(key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE memory_vector_units(state TEXT);
        CREATE INDEX vector_state ON memory_vector_units(state);",
        )
        .unwrap();
    assert!(
        !GenerationVectorAdapter::has_recall_vectors(root, &CognitionPathEnvironment::default())
            .unwrap()
    );
    graph.execute_batch("BEGIN EXCLUSIVE").unwrap();
    let reader =
        butler_platform::sqlite::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .unwrap();
    reader.busy_timeout(Duration::ZERO).unwrap();
    let error = reader
        .query_row("SELECT COUNT(*) FROM memory_state", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap_err();
    assert_eq!(
        error.sqlite_error_code(),
        Some(rusqlite::ErrorCode::DatabaseBusy)
    );
    graph
}
