//! WMS: migration creates inert schemas and preserves a populated work model.
#![allow(clippy::unwrap_used, clippy::panic, reason = "test assertions")]
use butler_e2e::e2e::{HarnessError, scenario::Setup};
use butler_work::{
    work_chain::{Chain, Step},
    work_queries,
    work_types::WorkId,
};
use rusqlite::{Connection, params_from_iter, types::Value};
use sha2::Digest;
use std::collections::BTreeMap;

type Snapshot = BTreeMap<String, Vec<Vec<Value>>>;
fn snapshot(db: &Connection) -> rusqlite::Result<Snapshot> {
    let names = db
        .prepare(
            "SELECT name FROM sqlite_schema WHERE type='table' AND name GLOB 'wm_*' ORDER BY name",
        )?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    names
        .into_iter()
        .map(|name| {
            let mut stmt = db.prepare(&format!("SELECT * FROM {name} ORDER BY 1,2"))?;
            let width = stmt.column_count();
            let rows = stmt
                .query_map([], |r| {
                    (0..width)
                        .map(|i| r.get(i))
                        .collect::<Result<Vec<Value>, _>>()
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok((name, rows))
        })
        .collect()
}
fn indexed(db: &Connection, sql: &str, expected: &str) -> rusqlite::Result<()> {
    let mut stmt = db.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?;
    let n = stmt.parameter_count();
    let plan = stmt
        .query_map(params_from_iter(std::iter::repeat_n(Value::Null, n)), |r| {
            r.get::<_, String>(3)
        })?
        .collect::<Result<Vec<_>, _>>()?
        .join("\n");
    assert!(
        plan.contains(expected) && !plan.contains("SCAN wm_"),
        "{plan}"
    );
    Ok(())
}
fn validate_chains(db: &Connection) -> Result<(), HarnessError> {
    let ids = db
        .prepare("SELECT id FROM wm_work_chains ORDER BY id")?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    assert_eq!(ids.len(), 3);
    for id in ids {
        let mut chain = Chain { steps: Vec::new() };
        let mut stmt = db.prepare(work_queries::Query::ChainMembers.sql())?;
        let rows = stmt.query_map([&id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, usize>(1)?,
                r.get::<_, usize>(2)?,
            ))
        })?;
        for row in rows {
            let (work, index, position) = row?;
            if index == chain.steps.len() {
                chain.steps.push(Step {
                    index,
                    works: Vec::new(),
                });
            }
            assert_eq!(position, chain.steps[index].works.len());
            chain.steps[index].works.push(WorkId(work));
        }
        chain.validate().unwrap();
        let stored = db.prepare("SELECT pred_work_id,succ_work_id FROM wm_work_edges WHERE chain_id=?1 ORDER BY pred_work_id,succ_work_id")?
            .query_map([&id],|r|Ok((WorkId(r.get(0)?),WorkId(r.get(1)?))))?.collect::<Result<Vec<_>,_>>()?;
        let mut computed = chain.edges().unwrap();
        computed.sort();
        assert_eq!(stored, computed);
    }
    Ok(())
}

fn validate_local_fixture(db: &Connection) -> Result<(), HarnessError> {
    assert_eq!(
        db.query_row::<i64, _, _>(
            "SELECT count(*) FROM wm_works
        WHERE visibility='private' AND home_session_id IS NOT NULL",
            [],
            |r| r.get(0)
        )?,
        0
    );
    assert_eq!(
        db.query_row::<i64, _, _>(
            "SELECT count(*) FROM wm_works
        WHERE run_state='idle' AND canon_status='planned' AND canon_status_source!='person'",
            [],
            |r| r.get(0)
        )?,
        0
    );
    let (hash, compressed, bytes) = db.query_row(
        "SELECT hash,body,bytes FROM wm_spec_bodies
        JOIN wm_spec_revisions ON hash=body_hash WHERE node_id='sp_canon'",
        [],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Vec<u8>>(1)?,
                r.get::<_, usize>(2)?,
            ))
        },
    )?;
    let body = zstd::stream::decode_all(compressed.as_slice())?;
    assert_eq!(body.len(), bytes);
    assert_eq!(
        String::from_utf8_lossy(&body),
        "계획·과제·명세를 사용자가 직접 편집하고 협업자와 공유한다. 작업·시도·검토는 실행 원장에 숨긴다."
    );
    assert_eq!(hash, format!("{:x}", sha2::Sha256::digest(&body)));
    assert_eq!(
        db.query_row::<String, _, _>("SELECT title FROM wm_tasks WHERE id='tk_board'", [], |r| r
            .get(0))?,
        "보드 순서 검토"
    );
    Ok(())
}

#[tokio::test]
async fn fresh_and_populated_schema_survive_restart() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("WMS-01")?.start().await?;
    s.agent.terminate().await?;
    let path = s.sandbox.data.join("agent-runtime/btcc.sqlite");
    let db = Connection::open(&path)?;
    let fresh = snapshot(&db)?;
    assert_eq!(fresh.len(), 25);
    assert!(fresh.values().all(Vec::is_empty));
    for query in work_queries::Query::all() {
        let index = query.index();
        assert_eq!(
            db.query_row::<i64, _, _>(
                "SELECT count(*) FROM sqlite_schema WHERE type='index' AND name=?1",
                [index],
                |r| r.get(0)
            )?,
            1
        );
    }
    let app = Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    assert_eq!(app.query_row::<i64,_,_>("SELECT count(*) FROM sqlite_schema WHERE name IN ('app_canon_sidebar_order','app_canon_sidebar_order_position','app_work_model_events')",[],|r|r.get(0))?,3);
    app.execute_batch(
        "INSERT INTO app_canon_sidebar_order VALUES
        ('butler','plan','first','A','op'),('butler','plan','second','B',NULL),
        ('butler','plan','third','C',NULL);",
    )?;
    assert!(
        app.execute(
            "INSERT INTO app_canon_sidebar_order VALUES
        ('other','backlog','fourth','D','op')",
            []
        )
        .is_err()
    );
    drop(app);
    db.execute_batch("PRAGMA foreign_keys=ON")?;
    db.execute_batch(include_str!("../../fixtures/work-model-p14/seed.sql"))?;
    validate_local_fixture(&db)?;
    validate_chains(&db)?;
    drop(db);
    let output =
        tokio::process::Command::new(butler_e2e::e2e::binary::fixture_binary("e2e-work-store")?)
            .kill_on_drop(true)
            .arg(&path)
            .arg("wk_canon")
            .output()
            .await?;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let db = Connection::open(&path)?;
    let mut before = snapshot(&db)?;
    assert_eq!(
        db.query_row::<String, _, _>(
            "SELECT run_state FROM wm_works WHERE id='wk_schema'",
            [],
            |r| r.get(0)
        )?,
        "held"
    );
    assert_eq!(
        db.query_row::<i64, _, _>(
            "SELECT count(*) FROM wm_hold_decisions WHERE chain_id='ch_canon' AND decision IS NULL",
            [],
            |r| r.get(0)
        )?,
        1
    );
    drop(db);
    s.gw = s.agent.start_again().await?;
    s.agent.terminate().await?;
    assert_publication(&s.sandbox.data, &mut before)?;
    let db = Connection::open(&path)?;
    assert_eq!(before, snapshot(&db)?);
    validate_chains(&db)?;
    for query in work_queries::Query::all() {
        let (sql, index) = (query.sql(), query.index());
        indexed(&db, sql, index)?;
    }
    drop(db);
    // Already published source rows must not append duplicate App events.
    s.gw = s.agent.start_again().await?;
    s.agent.terminate().await?;
    assert_publication(&s.sandbox.data, &mut before)?;
    let db = Connection::open(path)?;
    assert_eq!(before, snapshot(&db)?);
    drop(db);
    s.finish().await
}

/// Publication is the sole startup mutation in P1. Assert both sides of the
/// bridge and then keep the original exact snapshot check for every wm row.
fn assert_publication(data: &std::path::Path, expected: &mut Snapshot) -> Result<(), HarnessError> {
    let app = Connection::open(data.join("app-server/butler-client.sqlite"))?;
    let rows = expected.get_mut("wm_outbox").unwrap();
    assert_eq!(rows.len(), 2, "canon and queue invalidations");
    for row in rows.iter_mut() {
        let Value::Integer(seq) = row[0] else {
            panic!("outbox sequence");
        };
        let Value::Text(ref topic) = row[1] else {
            panic!("outbox topic");
        };
        let Value::Text(ref raw) = row[2] else {
            panic!("outbox JSON");
        };
        let original: serde_json::Value = serde_json::from_str(raw)?;
        let matches = app.prepare(
            "SELECT id,type,payload_json FROM events WHERE type=?1
             AND json_extract(payload_json,'$.revision')=?2
             AND (json_extract(payload_json,'$.id')=?3 OR json_extract(payload_json,'$.session_id')=?4)",
        )?.query_map(rusqlite::params![topic, original["revision"].as_i64(), original["id"].as_str(), original["session_id"].as_str()],
            |r| Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        assert_eq!(matches.len(), 1, "one durable App event for btcc seq {seq}");
        let (id, event_topic, raw) = &matches[0];
        let mut payload: serde_json::Value = serde_json::from_str(raw)?;
        assert_eq!(event_topic, topic);
        if topic == "canon.changed" {
            assert_eq!(payload["event_seq"], *id);
            payload.as_object_mut().unwrap().remove("event_seq");
        }
        assert_eq!(payload, original);
        row[3] = Value::Integer(1);
    }
    assert_eq!(
        app.query_row::<usize, _, _>("SELECT count(*) FROM app_work_model_events", [], |r| r
            .get(0))?,
        0
    );
    assert_eq!(
        app.query_row::<usize, _, _>(
            "SELECT count(*) FROM events WHERE type IN ('canon.changed','work_queue.changed')",
            [],
            |r| r.get(0)
        )?,
        rows.len()
    );
    Ok(())
}
