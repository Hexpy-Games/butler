//! The progress path at the owner's App history scale, never owner data.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test fixture assertions"
)]
use butler_e2e::e2e::HarnessError;
use std::path::Path;

pub(crate) async fn seed(data: &Path) -> Result<u64, HarnessError> {
    let path = data.join("app-server/butler-client.sqlite");
    let cursor = tokio::task::spawn_blocking(move || {
        let db = butler_platform::sqlite::open(&path).expect("fixture database");
        db.execute_batch("BEGIN;
            WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<599)
            INSERT INTO chats(id,title,kind,created_at,updated_at)
            SELECT 'update-scale-'||i,'Chat '||i,'chat','2099-01-01','2099-01-01' FROM n;
            WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<299999)
            INSERT INTO events(type,turn_id,payload_json,created_at)
            SELECT 'fixture.update-scale','',json_object('text',hex(zeroblob(2048))),'2099-01-01' FROM n;
            COMMIT; PRAGMA wal_checkpoint(TRUNCATE);").expect("owner-scale seed");
        let events: u64 = db.query_row("SELECT COUNT(*) FROM events WHERE type='fixture.update-scale'", [], |r| r.get(0)).expect("complete events");
        let chats: u64 = db.query_row("SELECT COUNT(*) FROM chats WHERE id LIKE 'update-scale-%'", [], |r| r.get(0)).expect("complete chats");
        assert_eq!((chats, events), (600, 300_000));
        let size = std::fs::metadata(&path).expect("database size").len();
        assert!(size >= 1_000_000_000, "owner-scale database: {size}");
        eprintln!("UPDATE-PROGRESS owner scale: chats={chats}, events={events}, database_bytes={size}");
        db.query_row("SELECT MAX(id) FROM events", [], |r| r.get(0)).expect("seed cursor")
    }).await.expect("seed task");
    Ok(cursor)
}
