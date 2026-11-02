//! CB-11: real chat -> reviewed delegation -> capped Workers, stub provider.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
#[path = "worker_cap/historical.rs"]
mod historical;
#[path = "worker_cap/plans.rs"]
mod plans;
#[path = "worker_cap/recovery.rs"]
pub(crate) mod recovery;
#[path = "worker_cap/regressions.rs"]
mod regressions;
#[path = "worker_cap/waiting.rs"]
mod requires_e2e_fixtures;
#[path = "worker_cap/stub.rs"]
pub(crate) mod stub;
#[path = "worker_cap/user_flows.rs"]
mod user_flows;
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    scenario::{Scenario, Setup},
};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

pub(crate) async fn setup(
    name: &str,
    count: usize,
) -> Result<
    (
        Scenario,
        std::sync::Arc<stub::Script>,
        tokio::task::JoinHandle<()>,
    ),
    HarnessError,
> {
    let (url, script, server) = stub::start(count).await?;
    let s = Setup::new(name)?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", &url)
        .start()
        .await?;
    s.patch_settings(json!({"max_simultaneous_workers":2}), "worker cap")
        .await?;
    Ok((s, script, server))
}

pub(crate) async fn workers(
    s: &Scenario,
    chat: &str,
    count: usize,
) -> Result<(String, Vec<Value>), HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let view =
            s.gw.get(&format!("/session-view?session_id={chat}"))
                .await?;
        if let Some(child) = view.data()["steward_children"]
            .as_array()
            .and_then(|v| v.first())
        {
            let id = child["session_id"].as_str().unwrap();
            let view = s.gw.get(&format!("/session-view?session_id={id}")).await?;
            if let Some(rows) = view.data()["workers"].as_array()
                && rows.len() == count
            {
                return Ok((id.into(), rows.clone()));
            }
        }
        assert!(
            Instant::now() < deadline,
            "Workers missing: {}\n{}",
            view.text,
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

pub(crate) async fn started(script: &stub::Script, expected: usize) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while script.started.lock().unwrap().len() < expected {
        assert!(
            Instant::now() < deadline,
            "Workers did not start: {:?}",
            script.started.lock().unwrap()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(script.started.lock().unwrap().len(), expected);
}

pub(crate) async fn closed(s: &Scenario, child: &str) -> Result<(), HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let view =
            s.gw.get(&format!("/session-view?session_id={child}"))
                .await?;
        let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
        let saved: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM btcc_subsession_delegations d JOIN btcc_steward_results x ON x.relation_id=d.relation_id AND x.child_turn_id=d.child_turn_id WHERE x.child_session_id=?1 AND x.status='success')", [child], |r| r.get(0))?;
        if saved && view.data()["latest_turn"]["state"] == "delivered" {
            return Ok(());
        }
        assert!(
            Instant::now() < deadline,
            "Worker did not close: {}\n{}",
            view.text,
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn cb_11_fifo_waiting_and_lowering_cap() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server) = setup("CB-11", 4).await?;
    s.gw.say("general", "Verify batch red").await?;
    let (_, rows) = workers(&s, "general", 3).await?;
    started(&script, 2).await;
    assert_eq!(rows[2]["status"], "waiting");
    assert_eq!(rows[2]["waiting_for_slot"], true);
    // Main's global activity surface still contains only visible App parents.
    let activity = s.gw.get("/worker-activity?include_history=true").await?;
    assert!(
        activity.data()["workers"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| {
                !row["worker_id"]
                    .as_str()
                    .unwrap()
                    .ends_with(rows[2]["relation"]["relation_id"].as_str().unwrap())
            })
    );
    plans::assert_indexed(&s)?;
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    for row in &rows[..2] {
        let bound: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM btcc_subsession_delegations d JOIN btcc_guided_works w ON w.work_id=d.root_work_id JOIN btcc_session_relations r USING(relation_id) JOIN btcc_guided_turn_work_bindings b ON b.work_id=w.work_id AND b.turn_id=d.child_turn_id AND b.is_current=1 WHERE r.child_session_id=?1 AND w.scope_kind='session' AND w.session_id=r.child_session_id)", [row["session_id"].as_str().unwrap()], |r| r.get(0))?;
        assert!(bound, "Worker must own its correctly scoped root Work");
    }
    drop(db);
    script.release("red-0");
    started(&script, 3).await;
    s.patch_settings(json!({"max_simultaneous_workers":1}), "lower cap")
        .await?;
    script.fourth.add_permits(1);
    let (_, rows) = workers(&s, "general", 4).await?;
    assert_eq!(rows[3]["status"], "waiting");
    assert_eq!(rows[1]["status"], "active");
    assert_eq!(rows[2]["status"], "active");
    script.release("red-1");
    closed(&s, rows[1]["session_id"].as_str().unwrap()).await?;
    assert_eq!(*script.started.lock().unwrap(), ["red-0", "red-1", "red-2"]);
    script.release("red-2");
    started(&script, 4).await;
    assert_eq!(
        *script.started.lock().unwrap(),
        ["red-0", "red-1", "red-2", "red-3"]
    );
    script.release("red-3");
    closed(&s, rows[3]["session_id"].as_str().unwrap()).await?;
    assert!(
        script
            .waiting_wording
            .load(std::sync::atomic::Ordering::SeqCst)
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn cb_11_two_stewards_have_independent_caps() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server) = setup("CB-11-INDEPENDENT", 2).await?;
    let created = s.gw.post("/sessions", json!({"kind":"chat"})).await?;
    let chat = created.data()["session"]["id"].as_str().unwrap().to_owned();
    s.gw.say("general", "Verify batch red").await?;
    s.gw.say(&chat, "Verify batch blue").await?;
    workers(&s, "general", 2).await?;
    workers(&s, &chat, 2).await?;
    started(&script, 4).await;
    let (_, red) = workers(&s, "general", 2).await?;
    let (_, blue) = workers(&s, &chat, 2).await?;
    for row in red.iter().chain(&blue) {
        assert_eq!(row["status"], "active");
    }
    for key in ["red-0", "red-1", "blue-0", "blue-1"] {
        script.release(key);
    }
    for row in red.iter().chain(&blue) {
        closed(&s, row["session_id"].as_str().unwrap()).await?;
    }
    s.finish().await?;
    server.abort();
    Ok(())
}

// test-category: race
#[tokio::test]
async fn cb_11_release_races_dispatch_and_waiting_steer() -> Result<(), HarnessError> {
    use std::sync::atomic::Ordering;
    butler_e2e::gate!();
    let (s, script, server) = setup("CB-11-RACE", 4).await?;
    script.steer.store(true, Ordering::SeqCst);
    s.gw.say("general", "Verify batch red").await?;
    let (_, rows) = workers(&s, "general", 3).await?;
    started(&script, 2).await;
    let deadline = Instant::now() + Duration::from_secs(30);
    while !script.steered.load(Ordering::SeqCst) {
        assert!(
            Instant::now() < deadline,
            "steer did not settle: {}",
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_pending_direction(&s, &rows[2])?;
    assert_eq!(script.started.lock().unwrap().len(), 2);
    // Release and dispatch become ready together on independent runtime lanes.
    let barrier = std::sync::Arc::new(tokio::sync::Barrier::new(3));
    let dispatch = {
        let barrier = barrier.clone();
        let script = script.clone();
        tokio::spawn(async move {
            barrier.wait().await;
            script.fourth.add_permits(1);
        })
    };
    let release = {
        let barrier = barrier.clone();
        let script = script.clone();
        tokio::spawn(async move {
            barrier.wait().await;
            script.release("red-0");
        })
    };
    barrier.wait().await;
    dispatch.await.unwrap();
    release.await.unwrap();
    let (_, rows) = workers(&s, "general", 4).await?;
    started(&script, 3).await;
    assert_eq!(*script.started.lock().unwrap(), ["red-0", "red-1", "red-2"]);
    assert_direction_applied(&s, &rows[2]).await?;
    assert_eq!(rows[3]["status"], "waiting");
    script.release("red-1");
    started(&script, 4).await;
    script.release("red-2");
    script.release("red-3");
    closed(&s, rows[3]["session_id"].as_str().unwrap()).await?;
    s.finish().await?;
    server.abort();
    Ok(())
}
fn assert_pending_direction(s: &Scenario, row: &Value) -> Result<(), HarnessError> {
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let state: String = db.query_row(
        "SELECT status FROM btcc_subsession_directions WHERE relation_id=?1",
        [row["relation"]["relation_id"].as_str().unwrap()],
        |r| r.get(0),
    )?;
    assert_eq!(state, "pending");
    Ok(())
}
async fn assert_direction_applied(s: &Scenario, row: &Value) -> Result<(), HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
        let applied: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM btcc_subsession_directions i JOIN btcc_subsession_delegations d USING(relation_id) WHERE i.relation_id=?1 AND i.status='applied' AND i.applied_child_turn_id=d.child_turn_id)",
            [row["relation"]["relation_id"].as_str().unwrap()], |r| r.get(0))?;
        if applied {
            return Ok(());
        }
        assert!(
            Instant::now() < deadline,
            "direction missing from first turn: {}",
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
