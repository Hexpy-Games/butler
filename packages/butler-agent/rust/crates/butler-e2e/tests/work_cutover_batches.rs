//! Migration transaction contracts; public startup flows live in WMU-12.
#![allow(clippy::unwrap_used, clippy::panic, reason = "test assertions")]
use butler_work::{cutover, store, work_schema};
use rusqlite::Connection;

fn fixture(extra: usize, title_bytes: usize) -> Connection {
    let mut db = Connection::open_in_memory().unwrap();
    db.execute_batch(include_str!("../fixtures/work-model-cutover/schema.sql"))
        .unwrap();
    work_schema::ensure(&db).unwrap();
    db.execute_batch(include_str!("../fixtures/work-model-cutover/btcc.sql"))
        .unwrap();
    let tx = db.transaction().unwrap();
    for i in 0..extra {
        tx.execute("INSERT INTO btcc_guided_works(work_id,scope_kind,scope_ref,session_id,objective,status,created_at,updated_at,origin_turn_id,origin_message_id) VALUES(?1,'session','batch-session','batch-session',?2,'open','now','now','origin-turn','origin-message')",
            rusqlite::params![format!("batch-{i:04}"), "a".repeat(title_bytes)]).unwrap();
    }
    tx.commit().unwrap();
    let tx = store::Transaction::new(db.transaction().unwrap()).unwrap();
    cutover::resume(&tx, cutover::CutoverState::Importing).unwrap();
    tx.commit().unwrap();
    db
}
fn ctx() -> store::Context {
    store::Context {
        now: 1000,
        actor: serde_json::json!({"origin":"migration"}),
    }
}
fn count(db: &Connection, table: &str) -> i64 {
    db.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}
fn cursor(db: &Connection) -> String {
    db.query_row(cutover::CURSOR, [], |r| r.get(0)).unwrap()
}

// test-category: pure-logic
#[test]
fn multi_work_batch_rolls_back_and_replays_without_duplicate_effects()
-> Result<(), butler_e2e::e2e::HarnessError> {
    butler_e2e::gate!();
    let mut db = fixture(40, 20);
    let initial = cursor(&db);
    let tx = store::Transaction::new(db.transaction().unwrap()).unwrap();
    assert!(cutover::batch(&tx, &ctx()).unwrap());
    assert!(count(&tx, "wm_works") > 1);
    tx.rollback().unwrap();
    assert_eq!(count(&db, "wm_works"), 0);
    assert_eq!(cursor(&db), initial);
    let tx = store::Transaction::new(db.transaction().unwrap()).unwrap();
    assert!(cutover::batch(&tx, &ctx()).unwrap());
    tx.commit().unwrap();
    let committed = cursor(&db);
    assert_eq!(count(&db, "wm_works"), 43);
    assert_eq!(count(&db, "wm_audit"), 1);
    assert_eq!(count(&db, "wm_outbox"), 0);
    let total: i64 = db
        .query_row(
            "SELECT sum(count) FROM wm_counts WHERE key='works'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(total, 43);
    let states: i64 = db
        .query_row(
            "SELECT sum(count) FROM wm_counts WHERE key LIKE 'run_state:%'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(states, total);
    let tx = store::Transaction::new(db.transaction().unwrap()).unwrap();
    tx.execute("UPDATE wm_migration SET cursor_json=?1", [initial])
        .unwrap();
    assert!(cutover::batch(&tx, &ctx()).unwrap());
    tx.commit().unwrap();
    assert_eq!(cursor(&db), committed);
    assert_eq!(count(&db, "wm_audit"), 1);
    assert_eq!(count(&db, "wm_works"), 43);
    loop {
        let tx = store::Transaction::new(db.transaction().unwrap()).unwrap();
        let more = cutover::batch(&tx, &ctx()).unwrap();
        tx.commit().unwrap();
        if !more {
            break;
        }
    }
    assert_eq!(count(&db, "wm_outbox"), 1);
    let topic: String = db
        .query_row("SELECT topic FROM wm_outbox", [], |r| r.get(0))
        .unwrap();
    assert_eq!(topic, "stream.reconcile_required");
    Ok(())
}

// test-category: pure-logic
#[test]
fn batches_stop_at_row_and_byte_bounds() -> Result<(), butler_e2e::e2e::HarnessError> {
    butler_e2e::gate!();
    for (extra, bytes, maximum) in [(600, 10, 500), (40, 65536, 16)] {
        let mut db = fixture(extra, bytes);
        let tx = store::Transaction::new(db.transaction().unwrap()).unwrap();
        assert!(cutover::batch(&tx, &ctx()).unwrap());
        let imported = count(&tx, "wm_works");
        assert!(imported > 1 && imported <= maximum, "{imported}");
        tx.commit().unwrap();
        let tx = store::Transaction::new(db.transaction().unwrap()).unwrap();
        assert!(cutover::batch(&tx, &ctx()).unwrap());
        assert!(count(&tx, "wm_works") > imported);
        tx.commit().unwrap();
    }
    Ok(())
}
