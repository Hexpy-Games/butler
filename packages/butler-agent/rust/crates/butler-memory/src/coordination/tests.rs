use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use super::*;

struct Host {
    pid: u32,
    hostname: String,
    ids: AtomicU64,
    statuses: Mutex<HashMap<u64, CognitionProcessStatus>>,
}

impl Host {
    fn new(pid: u32, hostname: &str) -> Self {
        Self {
            pid,
            hostname: hostname.into(),
            ids: AtomicU64::new(1),
            statuses: Mutex::new(HashMap::new()),
        }
    }

    fn status(&self, pid: u64, status: CognitionProcessStatus) {
        self.statuses.lock().insert(pid, status);
    }
}

impl CognitionCoordinationHost for Host {
    fn process_id(&self) -> u32 {
        self.pid
    }

    fn hostname(&self) -> CoordinationResult<String> {
        Ok(self.hostname.clone())
    }

    fn process_status(&self, pid: u64) -> CognitionProcessStatus {
        self.statuses
            .lock()
            .get(&pid)
            .copied()
            .unwrap_or(CognitionProcessStatus::Uncertain)
    }

    fn new_uuid(&self) -> String {
        format!("uuid-{}", self.ids.fetch_add(1, Ordering::Relaxed))
    }

    fn now_epoch_millis(&self) -> i64 {
        1_789_344_000_000
    }

    fn now_iso(&self) -> String {
        "2026-09-14T00:00:00.000Z".into()
    }
}

struct Fixture {
    root: PathBuf,
    lock: PathBuf,
}

impl Fixture {
    fn new(name: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "butler-coordination-{name}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let lock = root.join("cognition/consolidation/locks/consolidation.lock");
        Self { root, lock }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// Race: the exclusive write gate's fencing. A real gate preserves its fence
/// and release projection, and dropping a guard rolls back without an old
/// guard removing its successor's registration.
// test-category: race
#[test]
fn exclusive_gate_fences_and_guard_drop_order() {
    real_exclusive_gate_preserves_fence_and_release_projection();
    drop_rolls_back_and_old_guard_does_not_remove_successor_registration();
}

fn real_exclusive_gate_preserves_fence_and_release_projection() {
    let fixture = Fixture::new("exclusive");
    let first = CognitionWriteCoordinator::new(Arc::new(Host::new(101, "host-a"))).unwrap();
    let second = CognitionWriteCoordinator::new(Arc::new(Host::new(202, "host-a"))).unwrap();

    let before = first.inspect(&fixture.lock).unwrap();
    assert_eq!(
        before.state,
        ConsolidationLockState::InitializationAvailable
    );
    let lease = first
        .try_acquire(&CognitionWriteAcquire::immediate(
            fixture.lock.clone(),
            " projection ",
        ))
        .unwrap()
        .unwrap();
    assert_eq!(lease.owner().pid, 101);
    assert_eq!(lease.owner().purpose, "projection");
    let held = first.inspect(&fixture.lock).unwrap();
    assert_eq!(held.state, ConsolidationLockState::Held);
    assert!(
        second
            .try_acquire(&CognitionWriteAcquire::immediate(
                fixture.lock.clone(),
                "consolidation",
            ))
            .unwrap()
            .is_none()
    );
    assert_eq!(
        second.inspect(&fixture.lock).unwrap().state,
        ConsolidationLockState::Busy
    );

    std::fs::write(fixture.root.join("protected"), "profile-write").unwrap();
    let fence = std::fs::read_to_string(&fixture.lock).unwrap();
    assert_eq!(
        fence,
        r#"{"schema":"butler.memory-write-fence.v1","format_version":1,"fence_id":"uuid-2","created_at":"2026-09-14T00:00:00.000Z"}"#
    );
    lease.release(true).unwrap();

    let db = rusqlite::Connection::open(super::fence::coordinator_path(&fixture.lock)).unwrap();
    let (singleton, version, hash, owner): (i64, i64, String, String) = db
        .query_row(
            "SELECT singleton,format_version,fence_sha256,last_owner_json FROM memory_write_gate",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    let journal: String = db
        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
        .unwrap();
    drop(db);

    let next = second
        .try_acquire(&CognitionWriteAcquire::immediate(
            fixture.lock.clone(),
            "consolidation",
        ))
        .unwrap()
        .unwrap();
    assert_eq!(std::fs::read_to_string(&fixture.lock).unwrap(), fence);
    assert_eq!(next.owner().purpose, "consolidation");
    next.release(true).unwrap();
    let after = second.inspect(&fixture.lock).unwrap();
    assert_eq!(after.state, ConsolidationLockState::Free);
    assert_eq!(
        after.last_observed_owner.as_ref().unwrap().purpose,
        "consolidation"
    );
    let actual = serde_json::json!({
        "states": [state_text(before.state), state_text(held.state), state_text(after.state)],
        "purpose": "projection",
        "fenceRaw": fence
            .replace("uuid-2", "<uuid>")
            .replace("2026-09-14T00:00:00.000Z", "<iso>"),
        "ownerRaw": owner
            .replace("\"pid\":101", "\"pid\":<pid>")
            .replace("2026-09-14T00:00:00.000Z", "<iso>")
            .replace("host-a", "<host>")
            .replace("uuid-4", "<uuid>"),
        "coordinator": {
            "singleton": singleton,
            "format_version": version,
            "fence_hash_length": hash.len(),
            "journal_mode": journal,
        }
    });
    let source: serde_json::Value =
        serde_json::from_str(include_str!("tests/fixtures/source_shape.json")).unwrap();
    assert_eq!(actual, source);
}

fn drop_rolls_back_and_old_guard_does_not_remove_successor_registration() {
    let fixture = Fixture::new("drop");
    let coordinator = CognitionWriteCoordinator::new(Arc::new(Host::new(101, "host-a"))).unwrap();
    let lease = coordinator
        .try_acquire(&CognitionWriteAcquire::immediate(
            fixture.lock.clone(),
            "projection",
        ))
        .unwrap()
        .unwrap();
    let successor = LockInfo {
        pid: 101,
        started_at: "later".into(),
        host: "host-a".into(),
        owner_nonce: "successor".into(),
        purpose: "projection".into(),
    };
    // A successor registered the same path after this lease (e.g. after a
    // reclaim); dropping the old lease must not remove it.
    let local = &coordinator.inner.local;
    local.lock().insert(
        fixture.lock.clone(),
        coordinator::LocalRegistration {
            registration_id: "new-registration".into(),
            owner: successor,
        },
    );
    drop(lease);
    assert_eq!(
        local
            .lock()
            .get(&fixture.lock)
            .map(|registration| registration.registration_id.as_str()),
        Some("new-registration")
    );

    local.lock().remove(&fixture.lock);
    let reacquired = coordinator
        .try_acquire(&CognitionWriteAcquire::immediate(
            fixture.lock.clone(),
            "projection",
        ))
        .unwrap()
        .unwrap();
    drop(reacquired);
    let other = CognitionWriteCoordinator::new(Arc::new(Host::new(202, "host-a"))).unwrap();
    other
        .try_acquire(&CognitionWriteAcquire::immediate(
            fixture.lock.clone(),
            "projection",
        ))
        .unwrap()
        .unwrap()
        .release(false)
        .unwrap();
}

#[test]
fn legacy_reclaim_requires_same_host_definitely_dead_safe_pid() {
    let dead = Fixture::new("legacy-dead");
    write_legacy(&dead.lock, 404, "host-a");
    let raw = std::fs::read_to_string(&dead.lock).unwrap();
    let host = Arc::new(Host::new(101, "host-a"));
    host.status(404, CognitionProcessStatus::DefinitelyDead);
    let coordinator = CognitionWriteCoordinator::new(host).unwrap();
    coordinator
        .try_acquire(&CognitionWriteAcquire::immediate(
            dead.lock.clone(),
            "projection",
        ))
        .unwrap()
        .unwrap()
        .release(true)
        .unwrap();
    assert_eq!(std::fs::read_to_string(&dead.lock).unwrap(), raw);

    for (name, host_name, status) in [
        ("live", "host-a", CognitionProcessStatus::Alive),
        ("uncertain", "host-a", CognitionProcessStatus::Uncertain),
        ("foreign", "host-b", CognitionProcessStatus::DefinitelyDead),
    ] {
        let fixture = Fixture::new(name);
        write_legacy(&fixture.lock, 405, host_name);
        let host = Arc::new(Host::new(101, "host-a"));
        host.status(405, status);
        let coordinator = CognitionWriteCoordinator::new(host).unwrap();
        let Err(error) = coordinator.try_acquire(&CognitionWriteAcquire::immediate(
            fixture.lock.clone(),
            "projection",
        )) else {
            panic!("legacy owner should block acquisition")
        };
        assert_eq!(error.code(), "memory_write_legacy_blocked");
        assert_eq!(
            coordinator.inspect(&fixture.lock).unwrap().state,
            ConsolidationLockState::LegacyBlocked
        );
    }
}

fn write_legacy(path: &Path, pid: u64, host: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(
        path,
        serde_json::json!({
            "pid": pid,
            "startedAt": "2026-09-14T00:00:00.000Z",
            "host": host,
            "owner_nonce": "legacy",
            "purpose": "projection"
        })
        .to_string(),
    )
    .unwrap();
}

fn state_text(state: ConsolidationLockState) -> &'static str {
    match state {
        ConsolidationLockState::Free => "free",
        ConsolidationLockState::InitializationAvailable => "initialization_available",
        ConsolidationLockState::Held => "held",
        ConsolidationLockState::Busy => "busy",
        ConsolidationLockState::LegacyBlocked => "legacy_blocked",
        ConsolidationLockState::Unavailable => "unavailable",
    }
}
