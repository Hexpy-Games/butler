#![allow(clippy::unwrap_used, reason = "test assertions")]
use butler_canon::{store::*, work_schema};
use rusqlite::{Connection, TransactionBehavior};
use std::{
    path::PathBuf,
    sync::{Arc, Barrier},
    thread,
};
struct Database(PathBuf);
impl Database {
    fn new() -> Self {
        let result =
            Self(std::env::temp_dir().join(format!("work-{}.sqlite", uuid::Uuid::new_v4())));
        let db = result.open();
        work_schema::ensure(&db).unwrap();
        result
    }
    fn open(&self) -> Connection {
        connection(&self.0)
    }
}
impl Drop for Database {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
        for suffix in ["-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", self.0.display()));
        }
    }
}
fn connection(path: &std::path::Path) -> Connection {
    let db = Connection::open(path).unwrap();
    db.busy_timeout(std::time::Duration::from_secs(5)).unwrap();
    db.execute_batch("PRAGMA foreign_keys=ON").unwrap();
    db
}
fn race(
    db: &Database,
    operation: impl Fn(&Transaction<'_>, usize) -> Result<serde_json::Value> + Send + Sync + 'static,
) -> Vec<Result<serde_json::Value>> {
    let barrier = Arc::new(Barrier::new(2));
    let operation = Arc::new(operation);
    let handles: Vec<_> = (0..2)
        .map(|i| {
            let path = db.0.clone();
            let barrier = barrier.clone();
            let operation = operation.clone();
            thread::spawn(move || {
                let mut db = connection(&path);
                barrier.wait();
                let tx = Transaction::new(
                    db.transaction_with_behavior(TransactionBehavior::Immediate)
                        .unwrap(),
                )
                .unwrap();
                let result = operation(&tx, i);
                if result.is_ok() {
                    tx.commit().unwrap();
                } else {
                    tx.rollback().unwrap();
                }
                result
            })
        })
        .collect();
    handles.into_iter().map(|h| h.join().unwrap()).collect()
}
// test-category: race
#[test]
fn concurrent_first_mcp_calls_create_one_grant_and_event() {
    let file = Database::new();
    let results = race(&file, |tx, _| {
        let ctx = Context {
            now: 1,
            actor: serde_json::json!({"person":"person","client":"external-client","via":"External Client","origin":"mcp"}),
        };
        grants::admit(tx, &ctx, "canon.read")
    });
    for result in results {
        assert_eq!(result.unwrap()["code"], "trust_pending");
    }
    let db = file.open();
    assert_eq!(
        db.query_row("SELECT count(*) FROM canon_mcp_grants", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM canon_events WHERE topic='canon.trust_requested'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
}
