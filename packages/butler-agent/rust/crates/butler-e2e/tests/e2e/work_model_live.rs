//! WMU-01/02/18 through the real model-tool, effect and HTTP surfaces.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "E2E assertions")]
mod stub;
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    scenario::{Access, Setup},
};
const DESIGN: &str = "Design the requested outcome before execution.";
const CONTROL: &str = "Queue an instruction for the delegated work.";
const JOB: &str = "Write a marker, then integrate and review the result.";

#[tokio::test]
async fn quick_question_keeps_work_storage_empty() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, requests, server) = stub::start().await?;
    let s = Setup::new("WMU-01")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", url)
        .start()
        .await?;
    s.turn("general", "What is two plus two?").await?;
    let counts = database(&s, |db| {
        [
            "wm_works",
            "wm_tasks",
            "wm_spec_nodes",
            "wm_session_exec",
            "wm_instructions",
        ]
        .into_iter()
        .map(|table| {
            Ok((
                table,
                db.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| {
                    r.get::<_, i64>(0)
                })?,
            ))
        })
        .collect::<rusqlite::Result<Vec<_>>>()
    })
    .await?;
    for (table, count) in counts {
        assert_eq!(count, 0, "{table}");
    }
    assert_eq!(
        stub::requests_for(&requests, "What is two plus two?").len(),
        1,
        "no extra model round"
    );
    server.abort();
    s.finish().await
}

#[tokio::test]
async fn bootstrap_steps_effects_and_hidden_review() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, requests, server) = stub::start().await?;
    let setup = Setup::new("WMU-02-18")?
        .access(Access::FullAccess)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", url);
    let marker = setup.sandbox.data.join("marker.txt");
    let s = setup.start().await?;
    s.turn("general", JOB).await?;
    let requests = stub::requests_for(&requests, JOB);
    let out = stub::outputs(requests.last().unwrap());
    assert_eq!(out.len(), 10, "{out:?}");
    for value in &out[..9] {
        assert_ne!(value["ok"], false, "{value}");
    }
    assert_eq!(tokio::fs::read_to_string(marker).await?, "requested marker");
    assert_eq!(out[9]["error"]["code"], "task_not_started");
    assert_eq!(out[6]["view"]["task"]["status"], "in_review");
    assert_eq!(out[6]["view"]["parts"].as_array().unwrap().len(), 2);
    let work = out[0]["work"]["id"].as_str().unwrap();
    let reply = s.gw.get(&format!("/works/{work}/tasks")).await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    let chains = reply.data()["chains"].as_array().unwrap();
    assert_eq!(chains.len(), 1);
    let steps = chains[0]["steps"].as_array().unwrap();
    assert_eq!(steps.len(), 2);
    for step in steps {
        let tasks = step["tasks"].as_array().unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0]["status"], "completed");
        assert!(!tasks[0]["result_reported_at"].is_null());
    }
    let counts = database(&s, |db| {
        [
            ("wm_works", 1),
            ("wm_spec_nodes", 1),
            ("wm_tasks", 2),
            ("wm_reviews", 2),
        ]
        .into_iter()
        .map(|(table, expected)| {
            Ok((
                table,
                expected,
                db.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| {
                    r.get::<_, i64>(0)
                })?,
            ))
        })
        .collect::<rusqlite::Result<Vec<_>>>()
    })
    .await?;
    for (table, expected, count) in counts {
        assert_eq!(count, expected, "{table}");
    }
    server.abort();
    s.finish().await
}

#[tokio::test]
async fn request_during_importing_keeps_its_message_and_finishes_after_switch()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    use butler_e2e::e2e::scenario::accepted_turn_id;
    use serde_json::json;
    use std::time::{Duration, Instant};
    let (url, _requests, server) = stub::start().await?;
    let s = Setup::new("WMU-CUTOVER-WAIT")?
        .access(Access::FullAccess)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", url)
        .start()
        .await?;
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let status = s.gw.get("/work-model/cutover").await?;
        if status.data()["state"] == "done" {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "initial cutover did not finish: {status:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let other =
        s.gw.post(
            "/sessions",
            json!({"kind":"chat","title":"Quick questions"}),
        )
        .await?;
    assert_eq!(other.status, 201, "{}", other.text);
    let other = other.data()["session"]["id"].as_str().unwrap();
    database(&s, |db| {
        db.execute(
            "UPDATE wm_migration SET state='importing',writer_epoch=0 WHERE singleton=1",
            [],
        )
    })
    .await?;
    let turn = accepted_turn_id(&s.gw.say("general", JOB).await?)?;
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let admitted = database(&s, |db| {
            db.query_row("SELECT count(*) FROM wm_instructions", [], |r| {
                r.get::<_, i64>(0)
            })
        })
        .await?;
        if admitted == 1 {
            break;
        }
        assert!(Instant::now() < deadline, "managed receipt never admitted");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(
        database(&s, |db| db.query_row(
            "SELECT count(*) FROM wm_works",
            [],
            |r| r.get::<_, i64>(0)
        ))
        .await?,
        0
    );
    s.turn(other, "What is two plus two while the update runs?")
        .await?;
    database(&s, |db| {
        db.execute(
            "UPDATE wm_migration SET state='complete',writer_epoch=?1 WHERE singleton=1",
            [butler_work::cutover::WRITER_EPOCH],
        )
    })
    .await?;
    // The normal Tier 0 admission wakes the storage change subscriber.
    s.turn(other, "What is three plus three after the update?")
        .await?;
    let ended =
        s.gw.wait_terminal("general", &turn, Duration::from_secs(60))
            .await?;
    assert_eq!(
        butler_e2e::e2e::gateway::turn_state(&ended),
        "delivered",
        "{ended}"
    );
    assert_eq!(
        database(&s, |db| db.query_row(
            "SELECT count(*) FROM wm_tasks WHERE status='completed'",
            [],
            |r| r.get::<_, i64>(0)
        ))
        .await?,
        2
    );
    assert_eq!(
        database(&s, |db| db.query_row(
            "SELECT count(*) FROM wm_instructions",
            [],
            |r| r.get::<_, i64>(0)
        ))
        .await?,
        1
    );
    let anchor = turn.clone();
    let receipt = database(&s,move |db| db.query_row(
        "SELECT i.anchor_id,i.sender,i.status,b.body FROM wm_instructions i JOIN wm_spec_bodies b ON b.hash=i.body_ref WHERE i.anchor_id=?1",
        [anchor],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,Vec<u8>>(3)?))
    )).await?;
    assert_eq!(receipt.0, turn);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&receipt.1)?["user"]["principal_id"],
        "app-user"
    );
    assert_eq!(receipt.2, "applied");
    assert_eq!(
        zstd::stream::decode_all(receipt.3.as_slice())?,
        JOB.as_bytes()
    );
    server.abort();
    s.finish().await
}
async fn database<T: Send + 'static>(
    s: &butler_e2e::e2e::scenario::Scenario,
    operation: impl FnOnce(&rusqlite::Connection) -> rusqlite::Result<T> + Send + 'static,
) -> Result<T, HarnessError> {
    let path = s.sandbox.data.join("agent-runtime/btcc.sqlite");
    tokio::task::spawn_blocking(move || operation(&rusqlite::Connection::open(path)?))
        .await
        .map_err(|e| HarnessError(e.to_string()))?
        .map_err(HarnessError::from)
}

#[tokio::test]
async fn session_control_surface_is_limited_to_tier_two_parents() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, requests, server) = stub::start().await?;
    let s = Setup::new("WMU-TOOL-ROLES")?
        .access(Access::FullAccess)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", url)
        .start()
        .await?;
    s.turn("general", DESIGN).await?;
    let before = stub::requests_for(&requests, DESIGN);
    let results = stub::outputs(before.last().unwrap());
    assert_eq!(results[0]["ok"], true, "{results:?}");
    assert_eq!(results[0]["work"]["tier"], 2);
    let has_control = |request: &serde_json::Value| {
        request["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["name"] == "session_control")
    };
    assert!(!has_control(&before[0]));
    s.turn("general", CONTROL).await?;
    let requests = stub::requests_for(&requests, CONTROL);
    assert!(has_control(&requests[0]));
    let results = stub::outputs(requests.last().unwrap());
    assert_eq!(
        results.last().unwrap()["error"]["code"],
        "session_control_unavailable"
    );
    server.abort();
    s.finish().await
}
