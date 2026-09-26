use std::{
    cmp::Ordering,
    fs,
    path::PathBuf,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use crate::{
    conversation::{
        AgentConversationStore, ConversationIdentityClock, ConversationLocaleCollation,
        ConversationStoreConfig,
    },
    coordination::{CognitionCoordinationHost, CognitionProcessStatus, CognitionWriteAcquire},
};

use super::*;

/// Coordinator clock reads happen only inside write-gate acquisition in these
/// flows, so a read after `before` proves the operation is at the gate.
struct TestHost {
    clock_reads: tokio::sync::watch::Sender<usize>,
}

impl Default for TestHost {
    fn default() -> Self {
        Self {
            clock_reads: tokio::sync::watch::Sender::new(0),
        }
    }
}

impl TestHost {
    fn clock_reads(&self) -> usize {
        *self.clock_reads.borrow()
    }

    async fn gate_reached_after(&self, before: usize) {
        let mut reads = self.clock_reads.subscribe();
        tokio::time::timeout(
            Duration::from_secs(10),
            reads.wait_for(|reads| *reads > before),
        )
        .await
        .expect("operation must reach the write gate")
        .unwrap();
    }
}

impl ConversationIdentityClock for TestHost {
    fn id(&self, prefix: &'static str) -> String {
        format!("{prefix}_{}", uuid::Uuid::new_v4())
    }

    fn now_iso(&self) -> String {
        "2026-09-23T00:00:00.000Z".into()
    }
}

impl ConversationLocaleCollation for TestHost {
    fn compare(&self, left: &str, right: &str) -> Ordering {
        left.cmp(right)
    }
}

impl CognitionCoordinationHost for TestHost {
    fn process_id(&self) -> u32 {
        std::process::id()
    }

    fn hostname(&self) -> crate::coordination::CoordinationResult<String> {
        Ok("rebuild-cancel-test".into())
    }

    fn process_status(&self, pid: u64) -> CognitionProcessStatus {
        if pid == u64::from(std::process::id()) {
            CognitionProcessStatus::Alive
        } else {
            CognitionProcessStatus::Uncertain
        }
    }

    fn new_uuid(&self) -> String {
        uuid::Uuid::new_v4().to_string()
    }

    fn now_epoch_millis(&self) -> i64 {
        self.clock_reads.send_modify(|reads| *reads += 1);
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64
    }

    fn now_iso(&self) -> String {
        "2026-09-23T00:00:00.000Z".into()
    }
}

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "butler-rebuild-cancel-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(root.join("cognition/memory/generations")).unwrap();
        Self(root)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
async fn cancellation_while_waiting_for_write_gate_removes_staged_snapshot() {
    let fixture = Fixture::new();
    let canonical = fixture.0.join("runtime/conversation-store.sqlite");
    let host = Arc::new(TestHost::default());
    let store = AgentConversationStore::open(ConversationStoreConfig {
        path: canonical,
        identity_clock: host.clone(),
        collation: host.clone(),
    })
    .await
    .unwrap();
    store.close().await.unwrap();
    fs::write(
        fixture.0.join("cognition/memory/active-generation.json"),
        r#"{"schema":"butler.memory-active-generation.v2","generation_id":"11111111-1111-1111-1111-111111111111","projection_mode":"running"}"#,
    )
    .unwrap();

    let coordinator = Arc::new(CognitionWriteCoordinator::new(host.clone()).unwrap());
    let environment = CognitionPathEnvironment::default();
    let lock_path = environment.consolidation_lock(&fixture.0);
    let held = coordinator
        .try_acquire(&CognitionWriteAcquire::immediate(
            lock_path,
            "test_held_gate",
        ))
        .unwrap()
        .unwrap();
    let clock_before = host.clock_reads();
    let cancellation = CancellationToken::new();
    let running = tokio::spawn(prepare(
        fixture.0.clone(),
        environment,
        coordinator,
        cancellation.clone(),
        "2026-09-23T00:00:00.000Z".into(),
        "17.0.0".into(),
        "ICU4X 1.4.0".into(),
    ));

    let generations = fixture.0.join("cognition/memory/generations");
    host.gate_reached_after(clock_before).await;
    assert!(
        fs::read_dir(&generations)
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| {
                entry.file_name().to_string_lossy().starts_with(".prepare-")
                    && entry.path().join("graph.sqlite").is_file()
                    && entry
                        .path()
                        .join("source-snapshot/memory-source-inventory.json")
                        .is_file()
            }),
        "snapshot must stage before the write gate"
    );
    assert!(
        !running.is_finished(),
        "held write gate must block publication"
    );
    cancellation.cancel();
    let outcome = tokio::time::timeout(Duration::from_secs(5), running)
        .await
        .expect("cancelled acquisition must settle")
        .unwrap();
    assert_eq!(
        outcome.err().expect("acquisition must fail").code,
        "memory_operation_aborted"
    );
    assert_eq!(fs::read_dir(&generations).unwrap().count(), 0);
    held.release(false).unwrap();
}

#[tokio::test]
async fn readiness_rejects_candidate_change_while_waiting_for_commit_gate() {
    let fixture = Fixture::new();
    let canonical = fixture.0.join("runtime/conversation-store.sqlite");
    let host = Arc::new(TestHost::default());
    let store = AgentConversationStore::open(ConversationStoreConfig {
        path: canonical,
        identity_clock: host.clone(),
        collation: host.clone(),
    })
    .await
    .unwrap();
    store.close().await.unwrap();
    fs::write(
        fixture.0.join("cognition/memory/active-generation.json"),
        r#"{"schema":"butler.memory-active-generation.v2","generation_id":"11111111-1111-1111-1111-111111111111","projection_mode":"running"}"#,
    )
    .unwrap();
    let coordinator = Arc::new(CognitionWriteCoordinator::new(host.clone()).unwrap());
    let environment = CognitionPathEnvironment::default();
    let prepared = prepare(
        fixture.0.clone(),
        environment.clone(),
        coordinator.clone(),
        CancellationToken::new(),
        "2026-09-23T00:00:00.000Z".into(),
        "17.0.0".into(),
        "ICU4X 1.4.0".into(),
    )
    .await
    .unwrap();
    let target = crate::cognition::MemoryGenerationTarget::Rebuild {
        generation_id: prepared.generation_id.clone(),
        canonical_snapshot_id: prepared.canonical_snapshot_id,
    };
    let root = fixture
        .0
        .join("cognition/memory/generations")
        .join(&prepared.generation_id);
    let manifest = root.join("manifest.json");
    let original = fs::read(&manifest).unwrap();
    let lock = environment.consolidation_lock(&fixture.0);
    let held = coordinator
        .try_acquire(&CognitionWriteAcquire::immediate(
            lock,
            "test_held_readiness_gate",
        ))
        .unwrap()
        .unwrap();
    let clock_before = host.clock_reads();
    let cancellation = CancellationToken::new();
    let record = readiness::record(
        &fixture.0,
        &environment,
        coordinator.clone(),
        &target,
        &cancellation,
    );
    let cache = root.join("hot/cache.md");
    let change_after_compute = async {
        host.gate_reached_after(clock_before).await;
        fs::create_dir_all(cache.parent().unwrap()).unwrap();
        fs::write(&cache, "changed after readiness computation\n").unwrap();
        held.release(false).unwrap();
    };
    let (rejected, ()) = tokio::join!(record, change_after_compute);
    let rejected = rejected.unwrap_err();
    assert_eq!(rejected.code, "memory_generation_changed");
    assert_eq!(fs::read(&manifest).unwrap(), original);

    fs::remove_file(cache).unwrap();
    let current = readiness::record(
        &fixture.0,
        &environment,
        coordinator,
        &target,
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(current["unaccounted"], 0);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&fs::read(manifest).unwrap()).unwrap()["readiness"]
            ["sha256"],
        current["sha256"]
    );
}

#[tokio::test]
async fn representative_commit_rejects_changed_candidate_after_gate_wait() {
    let fixture = Fixture::new();
    let canonical = fixture.0.join("runtime/conversation-store.sqlite");
    let host = Arc::new(TestHost::default());
    let store = AgentConversationStore::open(ConversationStoreConfig {
        path: canonical,
        identity_clock: host.clone(),
        collation: host.clone(),
    })
    .await
    .unwrap();
    store.close().await.unwrap();
    fs::write(
        fixture.0.join("cognition/memory/active-generation.json"),
        r#"{"schema":"butler.memory-active-generation.v2","generation_id":"11111111-1111-1111-1111-111111111111","projection_mode":"running"}"#,
    )
    .unwrap();
    let coordinator = Arc::new(CognitionWriteCoordinator::new(host.clone()).unwrap());
    let environment = CognitionPathEnvironment::default();
    let prepared = prepare(
        fixture.0.clone(),
        environment.clone(),
        coordinator.clone(),
        CancellationToken::new(),
        "2026-09-23T00:00:00.000Z".into(),
        "17.0.0".into(),
        "ICU4X 1.4.0".into(),
    )
    .await
    .unwrap();
    let target = crate::cognition::MemoryGenerationTarget::Rebuild {
        generation_id: prepared.generation_id.clone(),
        canonical_snapshot_id: prepared.canonical_snapshot_id,
    };
    let handle = crate::cognition::resolve_generation(&fixture.0, &environment, &target).unwrap();
    let live = super::super::qualification_witness::LiveWitness::open(&fixture.0).unwrap();
    let candidate =
        super::super::qualification_witness::CandidateWitness::open(&fixture.0, &handle)
            .await
            .unwrap();
    let lock = environment.consolidation_lock(&fixture.0);
    let held = coordinator
        .try_acquire(&CognitionWriteAcquire::immediate(
            lock,
            "test_held_representative_gate",
        ))
        .unwrap()
        .unwrap();
    let clock_before = host.clock_reads();
    let row = crate::cognition::generation_vectors::GenerationVectorRow {
        vector_key: "a".repeat(64),
        generation: handle.generation_id.clone(),
        record_kind: "node".into(),
        owner_id: "node".into(),
        owner_revision: "revision".into(),
        source_revision: "source".into(),
        embedding_chunk_id: "b".repeat(64),
        embedding_version: "version".into(),
        project_id: String::new(),
        origin_kind: "user_input".into(),
        source_kind: "conversation".into(),
        conversation_session_id: None,
        source_observed_at: "2026-09-23T00:00:00.000Z".into(),
        source_refs_json: "[\"source\"]".into(),
        vector: vec![0.0; 1024],
    };
    let cancellation = CancellationToken::new();
    let pending =
        super::super::reconcile::commit_prepared(super::super::reconcile::PreparedCommit {
            data_root: &fixture.0,
            environment: &environment,
            coordinator,
            target: &target,
            cancellation: &cancellation,
            handle: &handle,
            live: &live,
            candidate: &candidate,
            prepared: vec![
                crate::cognition::generation_vectors::PreparedRepresentative {
                    row,
                    affected_unit_ids: vec!["unit".into()],
                },
            ],
        });
    let change = async {
        host.gate_reached_after(clock_before).await;
        let cache = handle.root.join("hot/cache.md");
        fs::create_dir_all(cache.parent().unwrap()).unwrap();
        fs::write(cache, "changed while gate held\n").unwrap();
        held.release(false).unwrap();
    };
    let (outcome, ()) = tokio::join!(pending, change);
    assert_eq!(outcome.unwrap_err().code, "memory_generation_changed");
    assert!(!handle.root.join("butler.lance").exists());
}
