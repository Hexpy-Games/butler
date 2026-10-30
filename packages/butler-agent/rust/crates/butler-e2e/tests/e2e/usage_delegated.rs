//! DELEG-USE — recursive attribution, exact totals and per-scope lineage caching.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
#[path = "usage_delegated/fixtures.rs"]
pub(crate) mod fixtures;
#[path = "usage_delegated/inheritance.rs"]
mod inheritance;
#[path = "usage_delegated/recovery.rs"]
mod recovery;
#[path = "usage_delegated/split.rs"]
mod split;
#[path = "usage_delegated/stub.rs"]
mod stub;
#[path = "usage_delegated/subtasks.rs"]
mod subtasks;
use butler_e2e::e2e::{HarnessError, cassette::Cassette, scenario::Setup};
use serde_json::Value;
use std::{
    fs,
    time::{Duration, Instant},
};
const ROOT: &str = "butler/app-general";
#[tokio::test]
async fn deleg_use_01_real_chat_steward_two_workers() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    let s = Setup::new("DELEG-USE-01")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"))
        .start()
        .await?;
    s.turn("general", super::delegate_followup::stub::OWNER)
        .await?;
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let view = s.gw.get("/session-view?session_id=general").await?;
        if view.data()["active_turn"].is_null()
            && view.data()["latest_turn"]["state"] == "delivered"
            && view.data()["steward_children"]
                .as_array()
                .unwrap()
                .iter()
                .any(|v| v["result"]["status"] == "success")
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "delegation did not finish: {}\n{}",
            view.text,
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let calls = script.calls.lock().unwrap().clone();
    for role in ["main", "steward", "worker-a", "worker-b"] {
        assert!(
            calls.iter().any(|v| v.0 == role),
            "missing {role}: {calls:?}\n{}",
            s.agent.logs()
        );
    }
    let total = |role: Option<&str>| {
        let rows: Vec<_> = calls
            .iter()
            .filter(|v| {
                role.is_none_or(|role| {
                    v.0 == role || role == "worker" && v.0.starts_with("worker-")
                })
            })
            .collect();
        (
            rows.len() as u64,
            rows.iter().map(|v| v.1).sum(),
            rows.iter().map(|v| v.2).sum(),
        )
    };
    let (n, input, output) = total(None);
    let monitor = s.gw.get("/usage-monitor?session_id=general").await?;
    fixtures::model(&monitor.data()["model"], n, input, output);
    let session = s.gw.get("/session-view?session_id=general").await?;
    fixtures::session(&session.data()["usage"], n, input, output);
    for role in ["main", "steward", "worker"] {
        let (n, input, output) = total(Some(role));
        fixtures::model(&monitor.data()["model"]["byRole"][role], n, input, output);
        fixtures::session(&session.data()["usage"]["by_role"][role], n, input, output);
    }
    let rows = fs::read_to_string(s.sandbox.data.join("metrics/prompt-cache-usage.jsonl"))?;
    let rows: Vec<Value> = rows
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(rows.len(), calls.len());
    for row in rows {
        assert_eq!(row["rootSessionId"], ROOT, "unstamped {row}");
        assert!(
            ["main", "steward", "worker"].contains(&row["role"].as_str().unwrap()),
            "{row}"
        );
    }
    super::usage_timeline::assert_timeline(monitor.data());
    s.finish().await?;
    server.abort();
    Ok(())
}
#[tokio::test]
async fn deleg_use_02_no_double_count_or_child_rows() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("DELEG-USE-02")?.start().await?;
    fixtures::append(
        &s.sandbox.data,
        &[fixtures::row(ROOT, Some(ROOT), Some("main"), 100, 20), {
            let mut row = fixtures::row("usage-child", Some(ROOT), Some("specialist"), 200, 30);
            row["promptTokens"] = 400.into();
            row
        }],
    )?;
    let global = s.gw.get("/usage-monitor?since_hours=24").await?;
    assert_eq!(global.data()["model"]["requestCount"], 2);
    assert_eq!(global.data()["model"]["totalTokens"], 350.0);
    assert_eq!(global.data()["model"]["promptTokens"], 500.0);
    assert_eq!(global.data()["model"]["outputTokens"], 20.0);
    assert!(global.data()["model"]["byRole"].is_null());
    let rows = global.data()["topSessions"].as_array().unwrap();
    assert!(
        rows.iter().all(|v| v["sessionId"] != "usage-child"),
        "child listed separately: {rows:?}"
    );
    let root = rows.iter().find(|v| v["sessionId"] == "general").unwrap();
    assert_eq!(root["totalTokens"], 350.0, "root missing delegated totals");
    assert!(
        rows.iter()
            .map(|v| v["totalTokens"].as_f64().unwrap())
            .sum::<f64>()
            <= 350.0
    );
    let child = s.gw.get("/usage-monitor?session_id=usage-child").await?;
    assert_eq!(child.data()["model"], {
        let mut model = global.data()["model"].clone();
        model["byRole"] = child.data()["model"]["byRole"].clone();
        model["subtasks"] = child.data()["model"]["subtasks"].clone();
        model
    });
    assert_eq!(child.data()["model"]["subtasks"]["promptTokens"], 400.0);
    assert_eq!(child.data()["timeline"]["slots"][0][5], 400.0);
    let slot = &child.data()["timeline"]["slots"][0];
    assert_eq!(slot[2].as_f64().unwrap() + slot[4].as_f64().unwrap(), 520.0);
    assert_eq!(slot.as_array().unwrap().len(), 9);
    assert_eq!(
        (slot[6].clone(), slot[7].clone(), slot[8].clone()),
        (1.into(), 10.0.into(), 0.0.into())
    );
    s.finish().await
}
#[tokio::test]
async fn deleg_use_05_slot_carries_subtask_requests_cached_output() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("DELEG-USE-05")?.start().await?;
    fixtures::append(
        &s.sandbox.data,
        &[
            fixtures::row(ROOT, Some(ROOT), Some("main"), 100, 20),
            fixtures::row("usage-a", Some(ROOT), Some("specialist"), 200, 30),
            fixtures::row("usage-b", Some(ROOT), Some("specialist"), 300, 40),
        ],
    )?;
    let view =
        s.gw.get("/usage-monitor?session_id=general&since_hours=24")
            .await?;
    let slots = view.data()["timeline"]["slots"].as_array().unwrap();
    let sum = |i: usize| slots.iter().map(|v| v[i].as_f64().unwrap()).sum::<f64>();
    assert_eq!(sum(5), 570.0, "delegated prompt+output");
    assert_eq!((sum(6), sum(7), sum(8)), (2.0, 20.0, 70.0));
    assert_eq!((sum(1), sum(3), sum(4)), (3.0, 30.0, 90.0));
    let all = s.gw.get("/usage-monitor?since_hours=24").await?;
    assert!(
        all.data()["timeline"]["slots"]
            .as_array()
            .unwrap()
            .iter()
            .all(|v| v.as_array().unwrap().len() == 5)
    );
    s.finish().await
}
#[tokio::test]
async fn deleg_use_03_recursive_legacy_cycle_and_cache() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("DELEG-USE-03")?.start().await?;
    fixtures::relations(
        &s.sandbox.data,
        &[
            ("usage-s1", ROOT, Some("steward")),
            ("usage-w1", "usage-s1", Some("worker")),
            ("usage-w2", "usage-w1", Some("future-role")),
            ("usage-cycle", "usage-cycle", None),
        ],
    )?;
    fixtures::append(
        &s.sandbox.data,
        &[
            fixtures::row(ROOT, None, None, 100, 20),
            fixtures::row("usage-s1", None, None, 200, 30),
            fixtures::row("usage-w1", None, Some("worker"), 300, 40),
            fixtures::row("usage-w2", None, None, 400, 50),
            fixtures::row("usage-cycle", None, None, 500, 60),
        ],
    )?;
    for pass in 0..2 {
        let view =
            s.gw.get("/usage-monitor?session_id=general&since_hours=24")
                .await?;
        fixtures::model(&view.data()["model"], 4, 1000, 140);
        for (role, input, output) in [
            ("main", 100, 20),
            ("steward", 200, 30),
            ("worker", 300, 40),
            ("future-role", 400, 50),
        ] {
            fixtures::model(&view.data()["model"]["byRole"][role], 1, input, output);
        }
        let session = s.gw.get("/session-view?session_id=general").await?;
        fixtures::session(&session.data()["usage"], 4, 1000, 140);
        let cycle = s.gw.get("/usage-monitor?session_id=usage-cycle").await?;
        fixtures::model(&cycle.data()["model"], 1, 500, 60);
        let global = s.gw.get("/usage-monitor?since_hours=24").await?;
        let rows = global.data()["topSessions"].as_array().unwrap();
        assert!(rows.iter().all(|row| row["sessionId"] != "usage-w1"));
        let root = rows
            .iter()
            .find(|row| row["sessionId"] == "general")
            .unwrap();
        assert_eq!(root["totalTokens"], 1140.0);
        if pass == 0 {
            rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?.execute(
                "DELETE FROM btcc_session_relations WHERE relation_id LIKE 'usage-%'",
                [],
            )?;
        }
    }
    s.finish().await
}
