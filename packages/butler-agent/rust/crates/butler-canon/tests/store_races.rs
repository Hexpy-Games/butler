#![allow(clippy::unwrap_used, reason = "test assertions")]
mod store_support;
use butler_canon::{store::*, work_schema};
use rusqlite::{Connection, TransactionBehavior};
use std::{
    path::PathBuf,
    sync::{Arc, Barrier},
    thread,
};
use store_support::*;
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
fn concurrent_canon_edit_has_one_winner_and_returns_current_value() {
    let file = Database::new();
    let mut db = file.open();
    work(&mut db, "a");
    drop(db);
    let results = race(&file, |tx, i| {
        let mut fields = WorkFields::from_snapshot(&read_work(tx, "a")?).unwrap();
        fields.title = format!("title-{i}");
        edit_work(tx, &context(), "a", 0, &fields)
    });
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    let winner = read_work(&file.open(), "a").unwrap();
    assert_eq!(winner["revision"], 1);
    let loser = results
        .into_iter()
        .find_map(std::result::Result::err)
        .unwrap();
    assert!(matches!(loser,Error::Conflict {current} if current==winner));
}
