//! A completed shutdown preserves every committed WAL row and public schedule.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test assertions")]

use butler_platform::sqlite;
use std::time::Instant;

use butler_e2e::e2e::{HarnessError, scenario::Setup};
use rusqlite::config::DbConfig;
use serde_json::json;

#[tokio::test]
async fn shutdown_preserves_large_wal_and_recovers_committed_rows() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("SHUTDOWN-WAL")?.start().await?;
    let reply =
        s.gw.post(
            "/automations",
            json!({
                "title": "Durable schedule", "prompt_body": "Remain queued",
                "target_session_id": "general", "interval_seconds": 3600,
            }),
        )
        .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    let id = reply.data()["automation"]["id"].clone();
    let path = s.sandbox.data.join("app-server/butler-client.sqlite");
    let mut db = sqlite::open(&path).unwrap();
    db.set_db_config(DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, true)
        .unwrap();
    db.execute_batch(
        "PRAGMA wal_autocheckpoint=0; PRAGMA synchronous=NORMAL;
        CREATE TABLE e2e_shutdown_rows(id INTEGER PRIMARY KEY, value BLOB NOT NULL)",
    )
    .unwrap();
    for batch in 0..8 {
        let tx = db.transaction().unwrap();
        tx.execute(
            "WITH RECURSIVE ids(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM ids WHERE x<1024)
            INSERT INTO e2e_shutdown_rows SELECT ?1*1024+x, zeroblob(8192) FROM ids",
            [batch],
        )
        .unwrap();
        tx.commit().unwrap();
    }
    drop(db);
    let wal = path.with_file_name("butler-client.sqlite-wal");
    let wal_before = std::fs::metadata(&wal)?.len();
    assert!(
        wal_before > 64 * 1024 * 1024,
        "fixture WAL too small: {wal_before}"
    );
    let started = Instant::now();
    s.agent.terminate().await?;
    let close = started.elapsed();
    let retained = std::fs::metadata(&wal)?.len();
    assert!(
        retained >= wal_before,
        "shutdown truncated committed WAL: {retained} < {wal_before}"
    );
    let started = Instant::now();
    s.gw = s.agent.start_again().await?;
    let ready = started.elapsed();
    let list = s.gw.get("/automations").await?;
    assert_eq!(list.status, 200, "{}", list.text);
    let rows = list.data()["automations"].as_array().unwrap().clone();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["id"], id);
    assert_eq!(rows[0]["title"], "Durable schedule");
    let db = sqlite::open(&path).unwrap();
    let verified: (i64, i64, i64, i64) = db
        .query_row(
            "SELECT count(*), min(id), max(id), sum(value=zeroblob(8192)) FROM e2e_shutdown_rows",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(verified, (8192, 1, 8192, 8192));
    drop(db);
    eprintln!(
        "shutdown WAL: before={wal_before} retained={retained} close={close:?} startup={ready:?}"
    );
    s.finish().await
}
