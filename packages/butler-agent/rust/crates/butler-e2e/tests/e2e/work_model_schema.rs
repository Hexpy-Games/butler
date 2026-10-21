//! WMS: migration creates inert schemas and preserves a populated work model.
#![allow(clippy::unwrap_used, reason = "test assertions")]
use butler_e2e::e2e::{HarnessError, scenario::Setup};
use butler_work::{
    work_chain::{Chain, Step},
    work_queries,
    work_types::WorkId,
};
use rusqlite::{Connection, params_from_iter, types::Value};
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
        let mut stmt = db.prepare(work_queries::CHAIN_MEMBERS)?;
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
    for (_, index) in work_queries::INDEXED_READS {
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
    assert_eq!(app.query_row::<i64,_,_>("SELECT count(*) FROM sqlite_schema WHERE name IN ('app_canon_sidebar_order','app_canon_sidebar_order_position')",[],|r|r.get(0))?,2);
    drop(app);
    db.execute_batch("PRAGMA foreign_keys=ON")?;
    db.execute_batch(include_str!("../../fixtures/work-model-p14/seed.sql"))?;
    let before = snapshot(&db)?;
    validate_chains(&db)?;
    drop(db);
    s.gw = s.agent.start_again().await?;
    s.agent.terminate().await?;
    let db = Connection::open(path)?;
    assert_eq!(before, snapshot(&db)?);
    validate_chains(&db)?;
    indexed(&db, work_queries::CHAT_QUEUE, "wm_work_chains_queue")?;
    indexed(&db, work_queries::READINESS, "wm_work_edges_successor")?;
    drop(db);
    s.finish().await
}
