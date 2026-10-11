//! Steward cards and mid-round steering through the real gateway and agent.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
mod files;
#[path = "steward_presentation/stub.rs"]
pub(super) mod stub;
use butler_e2e::e2e::{HarnessError, cassette::Cassette, scenario::Setup};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

#[tokio::test]
async fn steward_card_and_followup_continue_the_same_assignment() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    let setup = setup("STEWARD-PRESENTATION", &url)?.env("BUTLER_E2E_HOLD_TOOL", "read_file");
    std::fs::write(setup.sandbox.data.join("a.txt"), "Approach A")?;
    std::fs::write(setup.sandbox.data.join("b.txt"), "Approach B")?;
    *script.workspace.lock().unwrap() = setup.sandbox.data.display().to_string();
    let s = setup.start().await?;
    let (_, parent) = s.turn("general", stub::OWNER).await?;
    assert_eq!(parent["state"], "delivered", "{parent}");
    tokio::time::timeout(Duration::from_secs(20), script.held.notified())
        .await
        .unwrap_or_else(|_| panic!("{}\n{}", diagnostic(&script), s.agent.logs()));
    let view = s.gw.get("/session-view?session_id=general").await?;
    let child = &view.data()["steward_children"][0];
    assert_sidebar_work(&s, true).await?;
    assert_eq!(child["approved_plan_total"], 2, "{child}");
    assert_eq!(child["approved_plan_completed"], 1, "{child}");
    assert!(
        child["activity_rows"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["safe_tool_name"] == "read_file")
    );
    assert!(child["latest_turn"]["progress"]["summary"].is_string());
    let relation = child["relation"]["relation_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let child_id = child["session_id"].as_str().unwrap().to_owned();
    *script.relation.lock().unwrap() = relation.clone();
    let activity = s.gw.get("/worker-activity?include_history=true").await?;
    let worker = activity.data()["workers"][0]["worker_id"].clone();
    let messages = s.gw.messages("general").await?;
    assert!(
        messages.iter().any(|message| message["role"] == "assistant"
            && message["text"]
                .as_str()
                .is_some_and(|text| !text.is_empty())),
        "{messages:?}"
    );
    std::fs::write(s.sandbox.data.join("e2e-hold-tool"), b"once")?;
    script.release.notify_one();
    wait_held_tool(&s).await?;
    s.turn("general", stub::DIRECTION).await?;
    std::fs::remove_file(s.sandbox.data.join("e2e-hold-tool"))?;
    let complete = wait_result(&s).await?;
    assert_eq!(complete["relation"]["relation_id"], relation);
    assert_eq!(complete["session_id"], child_id);
    assert_eq!(complete["result"]["status"], "success", "{complete}");
    assert_eq!(complete["approved_plan_completed"], 2);
    assert!(
        complete["result"]["summary"]
            .as_str()
            .unwrap()
            .contains("키센스.txt"),
        "Delivery must preserve decomposed filename bytes: {complete}"
    );
    files::assert_delegated_files(&s).await?;
    assert_sidebar_work(&s, false).await?;
    let activity = s.gw.get("/worker-activity?include_history=true").await?;
    assert_eq!(activity.data()["workers"][0]["worker_id"], worker);
    assert_direction(&s, &script, relation);
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn delivered_steward_result_reports_blocked_work() -> Result<(), HarnessError> {
    use std::sync::atomic::Ordering;
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    script.blocked_disposition.store(true, Ordering::SeqCst);
    script.release.notify_one();
    let setup = setup("STEWARD-DELIVERED-BLOCKED-WORK", &url)?;
    for name in ["a.txt", "b.txt"] {
        std::fs::write(setup.sandbox.data.join(name), name)?;
    }
    *script.workspace.lock().unwrap() = setup.sandbox.data.display().to_string();
    let s = setup.start().await?;
    s.turn("general", stub::OWNER).await?;
    let child = wait_result(&s).await?;
    assert_eq!(child["result"]["status"], "blocked", "{child}");
    assert_eq!(child["result"]["work_status"], "blocked", "{child}");
    assert_eq!(child["status"], "failed", "{child}");
    assert_eq!(child["approved_plan_completed"], 1);
    let own =
        s.gw.get(&format!(
            "/session-view?session_id={}",
            child["session_id"].as_str().unwrap()
        ))
        .await?;
    assert_eq!(own.data()["status"], "failed");
    assert_eq!(own.data()["latest_turn"]["delivery_state"], "delivered");
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite")).unwrap();
    let status: String = db
        .query_row(
            "SELECT status FROM btcc_guided_works WHERE session_id=?1",
            [child["session_id"].as_str().unwrap()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        status, "blocked",
        "Work must retain its unfinished disposition"
    );
    drop(db);
    s.finish().await?;
    server.abort();
    Ok(())
}

pub(super) async fn unfinished_disposition_recovers_in_child() -> Result<(), HarnessError> {
    use std::sync::atomic::Ordering;
    let (url, script, server) = stub::start().await?;
    script.open_disposition.store(true, Ordering::SeqCst);
    script.release.notify_one();
    let setup = setup("STEWARD-OPEN-DISPOSITION", &url)?;
    for name in ["a.txt", "b.txt"] {
        std::fs::write(setup.sandbox.data.join(name), name)?;
    }
    *script.workspace.lock().unwrap() = setup.sandbox.data.display().to_string();
    let s = setup.start().await?;
    s.turn("general", stub::OWNER).await?;
    let deadline = Instant::now() + Duration::from_secs(30);
    let child = loop {
        let view = s.gw.get("/session-view?session_id=general").await?;
        let child = &view.data()["steward_children"][0];
        if child["result"].is_object() {
            break child.clone();
        }
        assert!(
            Instant::now() < deadline,
            "Open disposition lost its parent result: {view:?}\n{}",
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    assert_eq!(child["result"]["status"], "success", "{child}");
    let requests = script.requests.lock().unwrap().clone();
    let correction = requests
        .iter()
        .find(|r| r.to_string().contains("occurred 5 times"))
        .unwrap();
    assert!(correction.to_string().contains("Current Work:"));
    assert!(correction.to_string().contains("record_work_disposition"));
    assert!(
        requests
            .iter()
            .filter(|r| r.to_string().contains("Delegated result"))
            .all(|r| !r.to_string().contains("occurred 5 times")),
        "child counts leaked to parent"
    );
    assert_eq!(child["approved_plan_completed"], 2);
    loop {
        let messages = s.gw.messages("general").await?;
        if messages.iter().any(|message| {
            message["text"] == "Delegated work could not complete; progress remains saved."
        }) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "Failed child result never reached the parent: {messages:?}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn stopped_steward_projects_terminal_state_and_publishes_change() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    let setup = setup("STEWARD-STOP", &url)?;
    std::fs::write(setup.sandbox.data.join("a.txt"), "Approach A")?;
    *script.workspace.lock().unwrap() = setup.sandbox.data.display().to_string();
    let s = setup.start().await?;
    s.turn("general", stub::OWNER).await?;
    tokio::time::timeout(Duration::from_secs(20), script.held.notified())
        .await
        .unwrap();
    assert_sidebar_work(&s, true).await?;
    assert_owner_scale_sidebar(&s).await?;
    let view = s.gw.get("/session-view?session_id=general").await?;
    assert!(view.data()["active_turn"].is_null(), "parent has ended");
    let child = &view.data()["steward_children"][0];
    let relation = child["relation"]["relation_id"].as_str().unwrap();
    let child_id = child["session_id"].as_str().unwrap();
    let cursor = view.data()["cursors"]["events"].as_u64().unwrap();
    s.gw.post(
        &format!("/steward-relations/{relation}/cancel"),
        json!({"parent_session_id":"general"}),
    )
    .await?;
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let own =
            s.gw.get(&format!("/session-view?session_id={child_id}"))
                .await?;
        if own.data()["status"] == "cancelled" {
            assert!(own.data()["active_turn"].is_null());
            assert_ne!(own.data()["waiting_for_children"], true);
            assert_eq!(own.data()["latest_turn"]["cancellable"], false);
            break;
        }
        assert!(Instant::now() < deadline, "{own:?}\n{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let confirmed = Instant::now();
    loop {
        let events = s.gw.events_since(cursor).await?;
        if events.iter().any(|event| {
            event["type"] == "subsession.changed"
                && event["payload"]["child_session_id"] == child_id
        }) {
            break;
        }
        butler_e2e::assert_wall_clock_budget!(
            confirmed.elapsed(),
            Duration::from_millis(500),
            "terminal event"
        );
        assert!(
            Instant::now() < deadline,
            "missing terminal event: {events:?}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_sidebar_work(&s, false).await?;
    butler_e2e::assert_wall_clock_budget!(
        confirmed.elapsed(),
        Duration::from_millis(500),
        "terminal navigation"
    );
    println!(
        "stop confirmation to event/navigation: {} ms",
        confirmed.elapsed().as_millis()
    );
    script.release.notify_one();
    s.finish().await?;
    server.abort();
    Ok(())
}

async fn wait_held_tool(s: &butler_e2e::e2e::scenario::Scenario) -> Result<(), HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(20);
    let marker = s.sandbox.data.join("e2e-held-tool");
    while !marker.exists() {
        assert!(Instant::now() < deadline, "{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(std::fs::read_to_string(marker)?, "read-current");
    Ok(())
}

async fn wait_result(s: &butler_e2e::e2e::scenario::Scenario) -> Result<Value, HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let view = s.gw.get("/session-view?session_id=general").await?;
        let child = &view.data()["steward_children"][0];
        let messages = s.gw.messages("general").await?;
        if child["result"].is_object()
            && messages.iter().any(|message| {
                message["text"] == "Approach B verified." && message["status"] == "delivered"
            })
        {
            return Ok(child.clone());
        }
        assert!(Instant::now() < deadline, "{view:?}\n{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test]
async fn interrupted_steward_exposes_resume_and_keeps_the_same_turn() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    let setup = setup("STEWARD-RESUME", &url)?.env("BUTLER_E2E_INTERRUPT_TOOL", "read_file");
    std::fs::write(setup.sandbox.data.join("a.txt"), "Approach A")?;
    std::fs::write(setup.sandbox.data.join("b.txt"), "Approach B")?;
    *script.workspace.lock().unwrap() = setup.sandbox.data.display().to_string();
    let s = setup.start().await?;
    s.turn("general", stub::OWNER).await?;
    tokio::time::timeout(Duration::from_secs(20), script.held.notified())
        .await
        .unwrap_or_else(|_| panic!("{}\n{}", diagnostic(&script), s.agent.logs()));
    let initial = s.gw.get("/session-view?session_id=general").await?;
    let child = &initial.data()["steward_children"][0];
    let relation = child["relation"]["relation_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let turn = child["latest_turn"]["id"].clone();
    let child_id = child["session_id"].as_str().unwrap().to_owned();
    std::fs::write(s.sandbox.data.join("e2e-interrupt-tool"), b"once")?;
    script.release.notify_one();
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let view = s.gw.get("/session-view?session_id=general").await?;
        let child = &view.data()["steward_children"][0];
        if child["latest_turn"]["retryable"] == true {
            assert_eq!(child["latest_turn"]["state"], "runtime_fault");
            assert_eq!(child["status"], "failed");
            assert!(child["active_turn"].is_null());
            assert_eq!(child["terminal"], false);
            break;
        }
        assert!(Instant::now() < deadline, "{view:?}\n{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let own =
        s.gw.get(&format!("/session-view?session_id={child_id}"))
            .await?;
    assert_eq!(own.data()["status"], "failed");
    assert_eq!(own.data()["latest_turn"]["retryable"], true);
    let resumed =
        s.gw.post(
            &format!("/steward-relations/{relation}/resume"),
            json!({"parent_session_id":"general"}),
        )
        .await?;
    assert_eq!(resumed.status, 202, "{resumed:?}");
    let complete = wait_result(&s).await?;
    assert_eq!(complete["latest_turn"]["id"], turn);
    assert_eq!(complete["result"]["status"], "success");
    s.finish().await?;
    server.abort();
    Ok(())
}

fn assert_direction(
    s: &butler_e2e::e2e::scenario::Scenario,
    script: &stub::Script,
    relation: String,
) {
    let requests = script.requests.lock().unwrap().clone();
    assert!(requests.iter().any(
        |request| request.to_string().contains("Parent direction update")
            && request.to_string().contains(stub::DIRECTION)
    ));
    assert!(
        requests
            .iter()
            .flat_map(|request| request["input"].as_array().unwrap())
            .any(|item| {
                item["type"] == "function_call_output"
                    && item["call_id"] == "read-b"
                    && item["output"]
                        .as_str()
                        .is_some_and(|output| output.contains("Approach B"))
            }),
        "{}",
        diagnostic(script)
    );
    assert_eq!(
        requests
            .iter()
            .flat_map(|request| request["input"].as_array().unwrap())
            .filter(|item| item["type"] == "function_call"
                && item["name"] == "read_file"
                && item["call_id"] == "read-b")
            .count(),
        3
    );
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite")).unwrap();
    let applied: i64 = db.query_row(
        "SELECT count(*) FROM btcc_subsession_directions WHERE relation_id=?1 AND status='applied'",
        [relation],
        |row| row.get(0),
    ).unwrap();
    assert_eq!(applied, 1);
}

fn diagnostic(script: &stub::Script) -> String {
    let requests = script.requests.lock().unwrap();
    requests
        .iter()
        .map(|body| {
            let key = butler_e2e::e2e::matching::key("/codex/responses", body, &Default::default());
            let outputs: Vec<_> = body["input"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|item| item["type"] == "function_call_output")
                .collect();
            format!("request={} outputs={outputs:?}", key.user_request)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn setup(id: &str, url: &str) -> Result<Setup, HarnessError> {
    // Worker profile choices use the configured local gateway endpoint.
    let setup = Setup::new(id)?;
    // Holding/interruption fixtures need the debug-only tool hooks. The
    // original navigation/event budgets still apply to this slower binary.
    if let Some(binary) = std::env::var_os("BUTLER_E2E_FAULT_BIN") {
        butler_e2e::e2e::executable::copy(std::path::Path::new(&binary), &setup.sandbox.binary)?;
    }
    Ok(setup
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", url))
}

async fn assert_sidebar_work(
    s: &butler_e2e::e2e::scenario::Scenario,
    running: bool,
) -> Result<(), HarnessError> {
    let navigation = s.gw.get("/navigation").await?;
    let parent = navigation.data()["chats"]
        .as_array()
        .unwrap()
        .iter()
        .find(|session| session["id"] == "general")
        .unwrap();
    assert_eq!(parent["running_delegated_work"], running, "{parent}");
    Ok(())
}

async fn assert_owner_scale_sidebar(
    s: &butler_e2e::e2e::scenario::Scenario,
) -> Result<(), HarnessError> {
    let db =
        rusqlite::Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite")).unwrap();
    db.execute_batch(
        "WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<599)
        INSERT INTO chats(id,title,kind,created_at,updated_at)
        SELECT 'busy-scale-'||i,'Idle chat '||i,'chat','2026-01-01','2026-01-01' FROM n;",
    )
    .unwrap();
    let started = Instant::now();
    let navigation = s.gw.get("/navigation").await?;
    let elapsed = started.elapsed();
    let chats = navigation.data()["chats"].as_array().unwrap();
    assert_eq!(chats.len(), 601, "complete navigation at owner scale");
    assert_eq!(
        chats
            .iter()
            .filter(|chat| chat["running_delegated_work"] == true)
            .count(),
        1
    );
    assert!(
        chats
            .iter()
            .any(|chat| chat["id"] == "general" && chat["running_delegated_work"] == true)
    );
    butler_e2e::assert_wall_clock_budget!(
        elapsed,
        Duration::from_millis(500),
        "601-chat delegated navigation"
    );
    println!(
        "601-chat complete delegated navigation: {} ms",
        elapsed.as_millis()
    );
    Ok(())
}
