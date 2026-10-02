use std::{
    cmp::Ordering,
    fs,
    path::PathBuf,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use crate::coordination::{
    CognitionCoordinationHost, CognitionProcessStatus, CognitionWriteAcquire,
    CognitionWriteCoordinator,
};
use butler_turn::conversation::{
    AgentConversationStore, ConversationIdentityClock, ConversationLocaleCollation,
    ConversationStoreConfig,
};

use super::*;
use crate::cognition::CognitionPathEnvironment;
use tokio_util::sync::CancellationToken;

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
        i64::try_from(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis(),
        )
        .unwrap_or(i64::MAX)
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

/// Race: a rebuild's commit gate is check-then-act safe. A candidate that
/// changes while readiness waits for the gate is
/// rejected.
// test-category: race
#[tokio::test]
async fn rebuild_rejects_candidate_changes_during_gate_waits() {
    readiness_rejects_candidate_change_while_waiting_for_commit_gate().await;
}

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
    let (target, root) = candidate_fixture(&fixture.0);
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
    assert_eq!(rejected.code(), "memory_generation_changed");
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
    assert_eq!(current.unaccounted, 0);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&fs::read(manifest).unwrap()).unwrap()["readiness"]
            ["sha256"],
        serde_json::json!(current.sha256)
    );
}

fn candidate_fixture(
    data: &std::path::Path,
) -> (crate::cognition::MemoryGenerationTarget, PathBuf) {
    use super::super::{
        initialize::durable,
        manifest::{
            GenerationFormat, GenerationManifest, GenerationState, InitializationOrigin,
            NewManifest,
        },
        swap,
    };
    let generation_id = "22222222-2222-2222-2222-222222222222";
    let root = data
        .join("cognition/memory/generations")
        .join(generation_id);
    let source_root = root.join("source-snapshot");
    let snapshot = source_root.join("runtime/conversation-store.sqlite");
    swap::vacuum_snapshot(&data.join("runtime/conversation-store.sqlite"), &snapshot).unwrap();
    let inventory = inventory::read(
        &source_root,
        &snapshot,
        "2026-09-23T00:00:00.000Z",
        &CancellationToken::new(),
    )
    .unwrap();
    durable::write_json(
        &source_root.join("memory-source-inventory.json"),
        &inventory.inventory,
    )
    .unwrap();
    let mut manifest = GenerationManifest::new(
        NewManifest {
            generation_id,
            format: GenerationFormat::V2,
            state: GenerationState::Building,
            origin: InitializationOrigin::Rebuild,
            canonical_snapshot_id: "snapshot".into(),
            source_inventory_hash: inventory.hash,
            unaccounted_source_count: inventory.source_count as u64,
        },
        None,
    );
    manifest.canonical_snapshot_path =
        Some("source-snapshot/runtime/conversation-store.sqlite".into());
    durable::write_json(&root.join("manifest.json"), &manifest).unwrap();
    crate::cognition::graph::GraphRepository::create_fresh(
        &root.join("graph.sqlite"),
        "2026-09-23T00:00:00.000Z",
    )
    .unwrap();
    (
        crate::cognition::MemoryGenerationTarget::Rebuild {
            generation_id: generation_id.into(),
            canonical_snapshot_id: "snapshot".into(),
        },
        root,
    )
}
