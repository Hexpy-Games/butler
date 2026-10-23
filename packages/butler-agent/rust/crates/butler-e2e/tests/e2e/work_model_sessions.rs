//! WMU-22/23: per-session worker admission through the ordinary model and settings surfaces.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "E2E assertions")]
mod stub;
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    scenario::{Scenario, Setup},
};
use serde_json::{Value, json};
use std::time::{Duration, Instant};
const JOB: &str = "Prepare the bounded reports with workers.";
const DISPATCH: &str = "Delegate the bounded reports for the Task running here.";

async fn start(
    id: &str,
    workers: usize,
    here: bool,
) -> Result<
    (
        Scenario,
        std::sync::Arc<stub::Script>,
        tokio::task::JoinHandle<()>,
    ),
    HarnessError,
> {
    let (url, script, server) = stub::start(workers, here).await?;
    let s = Setup::new(id)?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", url)
        .start()
        .await?;
    cap(&s, 2).await?;
    Ok((s, script, server))
}
async fn cap(s: &Scenario, value: u32) -> Result<(), HarnessError> {
    let response =
        s.gw.patch("/settings", json!({"max_simultaneous_workers":value}))
            .await?;
    assert_eq!(response.status, 200, "{response:?}");
    Ok(())
}
async fn workers(s: &Scenario) -> Result<Vec<Value>, HarnessError> {
    super::work_model_live::database(s, |db| {
        db.prepare("SELECT i.state,a.status,a.id,r.parent_session_id,r.child_session_id,json_extract(i.payload_json,'$.delegation.packet.objective') FROM btcc_session_relations r JOIN wm_attempts a ON a.session_id=r.child_session_id JOIN wm_cross_db_intents i ON i.op_id='child_dispatch:'||a.id WHERE r.activity_role='worker' ORDER BY i.created_at,i.op_id")?
            .query_map([], |r| Ok(json!({"intent":r.get::<_,String>(0)?,"attempt":r.get::<_,String>(1)?,"id":r.get::<_,String>(2)?,"parent":r.get::<_,String>(3)?,"child":r.get::<_,String>(4)?,"objective":r.get::<_,String>(5)?})))?
            .collect::<rusqlite::Result<Vec<_>>>()
    }).await
}
async fn wait_workers(
    s: &Scenario,
    expected: usize,
    applied: usize,
) -> Result<Vec<Value>, HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let rows = workers(s).await?;
        if rows.len() == expected
            && rows.iter().filter(|r| r["intent"] == "applied").count() == applied
        {
            return Ok(rows);
        }
        assert!(Instant::now() < deadline, "{rows:?}\n{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
#[tokio::test]
async fn wmu_22_workers_wait_release_fifo_and_lowering_never_stops_them() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let (s, script, server) = start("WMU-22", 3, true).await?;
    s.turn("general", JOB).await?;
    s.turn("general", DISPATCH).await?;
    for output in script
        .requests
        .lock()
        .unwrap()
        .iter()
        .flat_map(super::work_model_script::outputs)
    {
        assert_ne!(output["ok"], false, "{output}");
    }
    let rows = wait_workers(&s, 3, 2).await?;
    assert!(rows.iter().all(|r| r["attempt"] == "running"));
    assert_eq!(
        rows.iter()
            .filter(|r| r["intent"] == "pending")
            .map(|r| &r["objective"])
            .collect::<Vec<_>>(),
        vec![&json!("Report piece 2")]
    );
    let pending = rows.iter().find(|r| r["intent"] == "pending").unwrap();
    let view = s.gw.get("/session-view?session_id=general").await?;
    assert_eq!(view.status, 200, "{view:?}");
    assert!(view.data()["workers"].as_array().unwrap().iter().any(|worker|
        worker["session_id"] == pending["child"] && worker["status"] == "waiting"), "{view:?}");
    let activity = s.gw.get("/sessions/general/worker-activity").await?;
    assert_eq!(activity.status, 200, "{activity:?}");
    assert!(
        activity.data()["workers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|worker| worker["objective"] == "Report piece 2"
                && worker["status_line"] == "Waiting"
                && worker["phase"] == "waiting"
                && worker["status_reference"]["parameters"]["phase"] == "waiting"),
        "{activity:?}"
    );
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let found = script
            .requests
            .lock()
            .unwrap()
            .iter()
            .flat_map(super::work_model_script::outputs)
            .any(|out| {
                out["status"] == "waiting"
                    && out["message"] == format!("Worker {} is waiting because this session already has 2 Workers running. It starts automatically when one of them finishes, and its result arrives like any other. Continue your own work and do not dispatch it again.",out["delegation_id"].as_str().unwrap())
            });
        if found {
            break;
        }
        assert!(Instant::now() < deadline, "waiting result never returned");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    script.release[0].add_permits(1);
    let current = wait_workers(&s, 3, 3).await?;
    assert_eq!(
        current.iter().filter(|r| r["attempt"] == "running").count(),
        2
    );
    assert_eq!(
        current
            .iter()
            .filter(|r| r["attempt"] == "succeeded")
            .count(),
        1
    );
    cap(&s, 1).await?;
    assert_eq!(
        workers(&s).await?,
        current,
        "lowering the cap stops neither running worker"
    );
    script.release[1].add_permits(1);
    script.release[2].add_permits(1);
    s.finish().await?;
    server.abort();
    Ok(())
}
#[tokio::test]
async fn wmu_23_two_sessions_each_run_two_workers() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server) = start("WMU-23", 2, false).await?;
    let response =
        s.gw.post("/sessions", json!({"kind":"chat","title":"Other reports"}))
            .await?;
    assert_eq!(response.status, 201, "{response:?}");
    let other = response.data()["session"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    s.turn("general", JOB).await?;
    s.turn(&other, JOB).await?;
    let rows = wait_workers(&s, 4, 4).await?;
    assert!(rows.iter().all(|r| r["attempt"] == "running"));
    let mut parents = std::collections::BTreeMap::new();
    for row in rows {
        *parents
            .entry(row["parent"].as_str().unwrap().to_owned())
            .or_insert(0) += 1;
    }
    assert_eq!(parents.values().copied().collect::<Vec<_>>(), vec![2, 2]);
    for release in &script.release {
        release.add_permits(2);
    }
    s.finish().await?;
    server.abort();
    Ok(())
}
