//! Steward cards and mid-round steering through the real gateway and agent.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
#[path = "steward_presentation/stub.rs"]
mod stub;
use butler_e2e::e2e::{HarnessError, cassette::Cassette, scenario::Setup};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

#[tokio::test]
async fn steward_card_and_followup_continue_the_same_assignment() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    let setup = setup("STEWARD-PRESENTATION", &url)
        .await?
        .env("BUTLER_E2E_HOLD_TOOL", "read_file");
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
    let activity = s.gw.get("/worker-activity?include_history=true").await?;
    assert_eq!(activity.data()["workers"][0]["worker_id"], worker);
    assert_direction(&s, &script, relation);
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
            && messages
                .iter()
                .any(|message| message["text"] == "Approach B verified.")
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
    let setup = setup("STEWARD-RESUME", &url)
        .await?
        .env("BUTLER_E2E_INTERRUPT_TOOL", "read_file");
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
        2
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

async fn setup(id: &str, url: &str) -> Result<Setup, HarnessError> {
    // Worker profile choices use the configured local gateway endpoint.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port().to_string();
    drop(listener);
    Ok(Setup::new(id)?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", url)
        .env("BUTLER_APP_SERVER_PORT", port))
}
