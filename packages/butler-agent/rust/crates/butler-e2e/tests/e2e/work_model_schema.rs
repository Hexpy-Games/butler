//! CB-12: upgrade an unreleased dev data folder through real agent startup.
#![allow(clippy::unwrap_used, reason = "test assertions")]
mod expected;
use butler_e2e::e2e::{HarnessError, events::LiveEvents, scenario::Setup};
use rusqlite::{Connection, types::Value};
use std::{collections::BTreeMap, time::Duration};
type Snapshot = BTreeMap<String, Vec<Vec<Value>>>;

fn rows(db: &Connection, sql: &str) -> rusqlite::Result<Vec<Vec<Value>>> {
    let mut stmt = db.prepare(sql)?;
    let width = stmt.column_count();
    stmt.query_map([], |r| (0..width).map(|i| r.get(i)).collect())?
        .collect()
}
fn snapshot(db: &Connection) -> rusqlite::Result<Snapshot> {
    let names = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name GLOB 'canon_*' ORDER BY name")?
        .query_map([], |r| r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    names
        .into_iter()
        .map(|name| {
            let data = rows(db, &format!("SELECT * FROM {name} ORDER BY 1,2"))?;
            Ok((name, data))
        })
        .collect()
}
fn no_legacy(db: &Connection) -> rusqlite::Result<()> {
    assert_eq!(
        rows(db, "SELECT name FROM sqlite_schema WHERE name GLOB 'wm_*'")?,
        Vec::<Vec<Value>>::new()
    );
    assert_eq!(
        rows(db, "PRAGMA foreign_key_check")?,
        Vec::<Vec<Value>>::new()
    );
    Ok(())
}
fn seed(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch(include_str!(
        "../../fixtures/work-model-p14/merged-schema.sql"
    ))?;
    db.execute_batch(include_str!("../../fixtures/work-model-p14/seed.sql"))
}
fn legacy_app(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch("DROP TABLE app_canon_conversations;
        CREATE TABLE app_canon_conversations(session_id TEXT PRIMARY KEY,work_id TEXT NOT NULL UNIQUE,project_id TEXT NOT NULL,op_id TEXT NOT NULL UNIQUE);
        INSERT INTO app_canon_conversations VALUES('old-chat','wk_canon','butler','old-op');")
}
fn migrated_app(db: &Connection) -> rusqlite::Result<()> {
    assert_eq!(
        rows(
            db,
            "SELECT session_id,epic_id,project_id,op_id FROM app_canon_conversations"
        )?,
        vec![vec![
            Value::Text("old-chat".into()),
            Value::Text("wk_canon".into()),
            Value::Text("butler".into()),
            Value::Text("old-op".into())
        ]]
    );
    db.execute_batch("INSERT INTO app_canon_conversations VALUES('old-chat','wk_docs','butler','op-2'),('second-chat','wk_canon','butler','op-3');")
}

#[tokio::test]
async fn cb_12_dev_upgrade_preserves_canon_and_second_start_is_identical()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("CB-12")?.start().await?;
    s.agent.terminate().await?;
    let path = s.sandbox.data.join("agent-runtime/btcc.sqlite");
    let db = Connection::open(&path)?;
    no_legacy(&db)?;
    let fresh = snapshot(&db)?;
    assert_eq!(fresh.len(), 15);
    assert!(fresh.values().all(Vec::is_empty));
    seed(&db)?;
    db.execute_batch(include_str!(
        "../../fixtures/work-model-p14/separation-values.sql"
    ))?;
    let expected = expected::snapshot(&db, fresh)?;
    let app_path = s.sandbox.data.join("app-server/butler-client.sqlite");
    legacy_app(&Connection::open(&app_path)?)?;
    drop(db);
    s.restart().await?;
    let stream = LiveEvents::subscribe(&s.gw, 0).await?;
    stream
        .wait_for(Duration::from_secs(10), |e| {
            e["type"] == "canon.changed" && e["payload"]["id"] == "wk_canon"
        })
        .await?;
    drop(stream);
    s.agent.terminate().await?;
    let db = Connection::open(&path)?;
    no_legacy(&db)?;
    assert_eq!(snapshot(&db)?, expected);
    migrated_app(&Connection::open(&app_path)?)?;
    drop(db);
    s.restart().await?;
    s.agent.terminate().await?;
    let db = Connection::open(&path)?;
    no_legacy(&db)?;
    assert_eq!(snapshot(&db)?, expected);
    drop(db);
    s.finish().await
}

#[tokio::test]
async fn cb_12_downgraded_dev_rows_merge_with_existing_canon_ids_winning()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("CB-12-MERGE")?.start().await?;
    s.agent.terminate().await?;
    let path = s.sandbox.data.join("agent-runtime/btcc.sqlite");
    let db = Connection::open(&path)?;
    db.execute_batch("INSERT INTO canon_plans VALUES('pl_p14','butler','Winning title','',NULL,'closed',99,1,2,'{}');")?;
    seed(&db)?;
    drop(db);
    s.restart().await?;
    s.agent.terminate().await?;
    let db = Connection::open(&path)?;
    no_legacy(&db)?;
    assert_eq!(
        rows(
            &db,
            "SELECT title,revision FROM canon_plans WHERE id='pl_p14'"
        )?,
        vec![vec![
            Value::Text("Winning title".into()),
            Value::Integer(99)
        ]]
    );
    assert_eq!(
        rows(&db, "SELECT count(*) FROM canon_epics")?,
        vec![vec![Value::Integer(9)]]
    );
    drop(db);
    s.finish().await
}
