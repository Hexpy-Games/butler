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
            "SELECT session_id,epic_id,project_id,op_id,is_home FROM app_canon_conversations"
        )?,
        vec![vec![
            Value::Text("old-chat".into()),
            Value::Text("wk_canon".into()),
            Value::Text("butler".into()),
            Value::Text("old-op".into()),
            Value::Integer(1)
        ]]
    );
    db.execute_batch("INSERT INTO app_canon_conversations(session_id,epic_id,project_id,op_id) VALUES('old-chat','wk_docs','butler','op-2'),('second-chat','wk_canon','butler','op-3');")
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
    assert_eq!(
        fresh.keys().map(String::as_str).collect::<Vec<_>>(),
        vec![
            "canon_audit",
            "canon_counters",
            "canon_cursors",
            "canon_epic_tags",
            "canon_epic_work_links",
            "canon_epics",
            "canon_events",
            "canon_intents",
            "canon_plans",
            "canon_proposals",
            "canon_session_epics",
            "canon_spec_bodies",
            "canon_spec_criteria",
            "canon_spec_nodes",
            "canon_spec_revisions",
            "canon_tags",
        ]
    );
    assert!(fresh.values().all(Vec::is_empty));
    seed(&db)?;
    db.execute_batch(include_str!(
        "../../fixtures/work-model-p14/separation-values.sql"
    ))?;
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
    expected::assert_rows(&db)?;
    let expected = snapshot(&db)?;
    migrated_app(&Connection::open(&app_path)?)?;
    drop(db);
    s.restart().await?;
    s.agent.terminate().await?;
    let db = Connection::open(&path)?;
    no_legacy(&db)?;
    assert_eq!(snapshot(&db)?, expected);
    assert_eq!(
        rows(
            &Connection::open(&app_path)?,
            "SELECT session_id,epic_id,project_id,op_id,is_home FROM app_canon_conversations ORDER BY session_id,epic_id"
        )?,
        vec![
            vec![
                Value::Text("old-chat".into()),
                Value::Text("wk_canon".into()),
                Value::Text("butler".into()),
                Value::Text("old-op".into()),
                Value::Integer(1)
            ],
            vec![
                Value::Text("old-chat".into()),
                Value::Text("wk_docs".into()),
                Value::Text("butler".into()),
                Value::Text("op-2".into()),
                Value::Integer(0)
            ],
            vec![
                Value::Text("second-chat".into()),
                Value::Text("wk_canon".into()),
                Value::Text("butler".into()),
                Value::Text("op-3".into()),
                Value::Integer(0)
            ],
        ]
    );
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
    db.execute_batch("INSERT INTO canon_audit(entity_kind,entity_id,revision,actor_json,op,at,payload_json) VALUES('plan','pl_p14',99,'{}','create',2,'{}');")?;
    seed(&db)?;
    db.execute_batch("INSERT INTO wm_audit VALUES(1,'plan','pl_p14',1,'{}','create',1,'{}'),(2,'work','wk_canon',1,'{}','create',1,'{}');")?;
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
    let audit = rows(&db, "SELECT * FROM canon_audit ORDER BY seq")?;
    assert_eq!(audit.len(), 2);
    assert_eq!(audit[0][3], Value::Integer(99));
    seed(&db)?;
    db.execute_batch("UPDATE wm_works SET home_session_id='losing-chat',created_at=0 WHERE id='wk_canon';
        INSERT INTO wm_cross_db_intents VALUES('losing-op','canon_conversation','{\"work_id\":\"wk_canon\",\"session_id\":\"losing-chat\",\"project_id\":\"butler\"}',1,'pending',0);
        INSERT INTO wm_audit VALUES(1,'plan','pl_p14',1,'{}','create',1,'{}'),(2,'work','wk_canon',2,'{}','edit',3,'{}');")?;
    drop(db);
    s.restart().await?;
    s.agent.terminate().await?;
    let db = Connection::open(&path)?;
    no_legacy(&db)?;
    let epic =
        butler_canon::store::read_api(&db, butler_canon::store::api::Resource::Epic, "wk_canon")
            .unwrap();
    assert_eq!(epic["home_session_id"], "chat_canon");
    assert_eq!(
        rows(&db, "SELECT * FROM canon_intents WHERE op_id='losing-op'")?,
        Vec::<Vec<Value>>::new()
    );
    assert_eq!(rows(&db, "SELECT * FROM canon_audit ORDER BY seq")?, audit);
    assert_eq!(
        rows(
            &db,
            "SELECT session_id FROM canon_session_epics WHERE epic_id='wk_canon'"
        )?,
        vec![vec![Value::Text("chat_canon".into())]]
    );
    drop(db);
    s.finish().await
}

#[tokio::test]
async fn cb_12_reupgrade_discards_colliding_history_and_outpaces_stale_receipts()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("CB-12-REUPGRADE")?.start().await?;
    s.agent.terminate().await?;
    let path = s.sandbox.data.join("agent-runtime/btcc.sqlite");
    let db = Connection::open(&path)?;
    seed(&db)?;
    db.execute_batch(include_str!(
        "../../fixtures/work-model-p14/separation-values.sql"
    ))?;
    drop(db);
    s.restart().await?;
    s.agent.terminate().await?;
    let db = Connection::open(&path)?;
    seed(&db)?;
    db.execute_batch(include_str!(
        "../../fixtures/work-model-p14/separation-values.sql"
    ))?;
    db.execute_batch("UPDATE wm_outbox SET seq=4 WHERE seq=1;")?;
    let app_path = s.sandbox.data.join("app-server/butler-client.sqlite");
    Connection::open(&app_path)?
        .execute("INSERT INTO app_work_model_events VALUES(4,999999)", [])?;
    drop(db);
    s.restart().await?;
    s.agent.terminate().await?;
    let db = Connection::open(&path)?;
    no_legacy(&db)?;
    let expected: Vec<_> = [
        ("work", "wk_canon"),
        ("plan", "pl_p14"),
        ("spec_node", "sp_canon"),
        ("backlog", "butler"),
    ]
    .into_iter()
    .enumerate()
    .map(|(index, (kind, id))| {
        vec![
            Value::Integer(i64::try_from(index).unwrap() + 1),
            Value::Text(kind.into()),
            Value::Text(id.into()),
        ]
    })
    .collect();
    assert_eq!(
        rows(
            &db,
            "SELECT seq,entity_kind,entity_id FROM canon_audit ORDER BY seq"
        )?,
        expected
    );
    assert_eq!(
        rows(&db, "SELECT seq,published FROM canon_events ORDER BY seq")?,
        vec![
            vec![Value::Integer(4), Value::Integer(1)],
            vec![Value::Integer(5), Value::Integer(1)],
        ]
    );
    assert_eq!(
        rows(&db, "SELECT count(*) FROM canon_epics")?,
        vec![vec![Value::Integer(9)]]
    );
    assert_eq!(
        rows(
            &Connection::open(&app_path)?,
            "SELECT count(*) FROM events WHERE type='canon.changed' AND json_extract(payload_json,'$.id')='wk_canon'"
        )?,
        vec![vec![Value::Integer(2)]]
    );

    drop(db);
    s.finish().await
}
