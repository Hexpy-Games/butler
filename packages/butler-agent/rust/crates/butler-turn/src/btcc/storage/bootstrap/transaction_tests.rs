//! Commit-count and complete published-image regression for fresh bootstrap.
#![allow(clippy::unwrap_used, reason = "test assertions")]
use super::*;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Instant;

fn previous_initialize(fresh: &FreshStorage<'_>, db: &mut Connection) {
    schema::create_current(db).unwrap();
    migration::apply(db).unwrap();
    db.execute_batch(METADATA_SCHEMA).unwrap();
    validate::empty_canonical_database(db).unwrap();
    db.execute(
            "INSERT INTO agent_storage_migration_receipt (singleton,manifest_id,receipt_json) VALUES (1,?1,?2)",
            params![fresh.id, fresh.receipt().to_string()],
        )
        .unwrap();
    validate::receipt(db, fresh.id).unwrap();
    let marker = json!({
        "schema": "butler.agent-btcc-storage-activation.v1",
        "manifestId": fresh.id,
        "storageContract": "split-v1",
        "runtimeVersion": fresh.runtime_version,
        "firstActivatedAt": fresh.now_iso,
        "activatedAt": fresh.now_iso,
    });
    db.execute(
            "INSERT INTO agent_storage_activation_marker (singleton,manifest_id,marker_json) VALUES (1,?1,?2)",
            params![fresh.id, marker.to_string()],
        )
        .unwrap();
    validate::readiness(db, fresh.id).unwrap();
}

fn snapshot(db: &Connection) -> Vec<(String, String, String, Option<String>)> {
    db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
}

fn metadata(db: &Connection) -> Vec<(String, String)> {
    db.prepare(
        "SELECT manifest_id,receipt_json FROM agent_storage_migration_receipt
                UNION ALL SELECT manifest_id,marker_json FROM agent_storage_activation_marker",
    )
    .unwrap()
    .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
    .unwrap()
    .collect::<rusqlite::Result<Vec<_>>>()
    .unwrap()
}

fn sample(root: &Path, previous: bool) -> (f64, usize, sqlite::Connection) {
    let started = Instant::now();
    let path = root.join(format!("{}.sqlite", uuid::Uuid::new_v4()));
    let temp = path.with_extension("tmp");
    let id = manifest_id();
    let fresh = FreshStorage {
        path: &path,
        parent: root,
        temp: &temp,
        id: &id,
        fence_id: "fence",
        runtime_version: "test",
        now_iso: "2026-10-20T00:00:00Z",
    };
    let commits = Arc::new(AtomicUsize::new(0));
    let counter = commits.clone();
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    butler_platform::secure_fs::owner_only(&mut options);
    drop(options.open(&temp).unwrap());
    let mut db = sqlite::open(&temp).unwrap();
    db.commit_hook(Some(move || {
        counter.fetch_add(1, Ordering::SeqCst);
        false
    }));
    if previous {
        previous_initialize(&fresh, &mut db);
    } else {
        fresh.initialize(&mut db).unwrap();
    }
    db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)").unwrap();
    db.close().unwrap();
    butler_platform::secure_fs::sync_path(&temp).unwrap();
    fresh.publish_and_activate().unwrap();
    remove_temp(&temp).unwrap();
    let elapsed = started.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(read_activated_storage_manifest(&path).unwrap(), id);
    let db = sqlite::open(&path).unwrap();
    validate::readiness(&db, &id).unwrap();
    (elapsed, commits.load(Ordering::SeqCst), db)
}

/// Pins the persisted schema and metadata alongside publication regression.
pub(super) fn fresh_schema_and_metadata_commit_once() {
    let root = std::env::temp_dir().join(format!("btcc-commits-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    let mut before = Vec::new();
    let mut after = Vec::new();
    let mut previous_commits = None;
    for _ in 0..20 {
        let (old_ms, old_commits, old) = sample(&root, true);
        let (new_ms, new_commits, new) = sample(&root, false);
        // One schema+metadata commit, plus migration's independent commit.
        assert_eq!(new_commits, 2);
        assert!(old_commits > new_commits);
        assert_eq!(*previous_commits.get_or_insert(old_commits), old_commits);
        assert_eq!(snapshot(&old), snapshot(&new));
        assert_eq!(metadata(&old), metadata(&new));
        assert_eq!(metadata(&new).len(), 2);
        before.push(old_ms);
        after.push(new_ms);
    }
    before.sort_by(f64::total_cmp);
    after.sort_by(f64::total_cmp);
    eprintln!(
        "20 fresh bootstraps: median before={:.3}ms after={:.3}ms; commits before={} after=2 (schema+metadata=1, migration=1)",
        f64::midpoint(before[9], before[10]),
        f64::midpoint(after[9], after[10]),
        previous_commits.unwrap()
    );
    fs::remove_dir_all(root).unwrap();
}
