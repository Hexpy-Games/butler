use std::fs;
use std::sync::atomic::{AtomicUsize, Ordering};

use super::*;
use crate::coordination::CognitionProcessStatus;
use crate::profile::contracts::ProfileHostFacts;

struct Root(std::path::PathBuf);
impl Root {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("butler-profile-claims-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for Root {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct Host {
    sequence: AtomicUsize,
    foreign: CognitionProcessStatus,
}
impl Host {
    fn new(foreign: CognitionProcessStatus) -> Self {
        Self {
            sequence: AtomicUsize::new(0),
            foreign,
        }
    }
}
impl ProfileHostFacts for Host {
    fn process_id(&self) -> u32 {
        1234
    }
    fn process_status(&self, _pid: f64) -> CognitionProcessStatus {
        self.foreign
    }
    fn new_uuid(&self) -> String {
        format!("nonce-{}", self.sequence.fetch_add(1, Ordering::SeqCst))
    }
    fn now_epoch_millis(&self) -> i64 {
        1_700_000_000_000
    }
    fn now_iso(&self) -> String {
        "2023-11-14T22:13:20.000Z".into()
    }
}

fn window() -> SourceWindow {
    super::super::discovery::make_window(super::super::discovery::SourceWindowInput {
        message_id: "message",
        timestamp: "2023-11-14T22:13:20.000Z",
        part_id: "part",
        part_index: 0.0,
        scalar_pointer: "/text",
        source_hash: "hash",
        text: "hello",
        byte_start: 0,
        byte_end: 5,
    })
}

fn register_window(root: &Root, window: &SourceWindow) {
    persist_discovery(
        &root.0,
        &SourceRead {
            scanned_session_count: 0,
            scanned_message_count: 0,
            windows: vec![window.clone()],
            discovery_incomplete: false,
            current_obligation_count: 1,
            stale_keys: Vec::new(),
            persistent_offset: None,
        },
        "2023-11-14T22:13:20.000Z",
    )
    .unwrap();
}

fn owner(root: &Root) -> (Option<f64>, Option<String>) {
    storage::open(&root.0, false)
        .unwrap()
        .query_row(
            "SELECT owner_pid,owner_nonce FROM profile_source_coverage",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap()
}

#[test]
fn same_process_claim_requires_exact_active_key_and_nonce_release() {
    let root = Root::new();
    let window = window();
    register_window(&root, &window);
    let host = Host::new(CognitionProcessStatus::DefinitelyDead);
    let active = Arc::new(Mutex::new(HashSet::new()));
    let nonce = claim(&root.0, std::slice::from_ref(&window), &host, &active)
        .unwrap()
        .unwrap();
    assert!(
        claim(&root.0, std::slice::from_ref(&window), &host, &active)
            .unwrap()
            .is_none()
    );
    release(
        &root.0,
        std::slice::from_ref(&window),
        "wrong-nonce",
        &host,
        &active,
    )
    .unwrap();
    assert_eq!(owner(&root), (Some(1234.0), Some(nonce.clone())));
    release(
        &root.0,
        std::slice::from_ref(&window),
        &nonce,
        &host,
        &active,
    )
    .unwrap();
    assert_eq!(owner(&root), (None, None));
}

#[test]
fn foreign_claim_recovery_requires_definite_death() {
    let root = Root::new();
    let window = window();
    register_window(&root, &window);
    let db = storage::open(&root.0, true).unwrap();
    db.execute(
        "UPDATE profile_source_coverage SET owner_pid=999,owner_nonce='foreign'",
        [],
    )
    .unwrap();
    drop(db);
    let active = Arc::new(Mutex::new(HashSet::new()));
    let uncertain = Host::new(CognitionProcessStatus::Uncertain);
    assert!(
        claim(&root.0, std::slice::from_ref(&window), &uncertain, &active,)
            .unwrap()
            .is_none()
    );
    let dead = Host::new(CognitionProcessStatus::DefinitelyDead);
    let nonce = claim(&root.0, std::slice::from_ref(&window), &dead, &active)
        .unwrap()
        .unwrap();
    assert_eq!(owner(&root), (Some(1234.0), Some(nonce)));
}
