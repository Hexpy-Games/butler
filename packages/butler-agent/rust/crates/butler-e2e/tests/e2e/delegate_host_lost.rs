//! A Steward that loses the browser host mid-delegation still ends with a parent answer.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
#[path = "support/delegate_host_lost_stub.rs"]
mod stub;
use butler_e2e::e2e::{HarnessError, cassette::Cassette, scenario::Setup, security::AdminClient};
use serde_json::Value;
use std::time::{Duration, Instant};

#[tokio::test]
async fn browser_host_lost_mid_delegation_still_answers_the_parent() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    let s = Setup::new("DELEGATE-HOST-LOST")?
        .clock_after_daily_jobs("2026-09-27T12:00:00.000Z")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"))
        .env("BUTLER_BROWSER_HEADLESS", "off")
        .start()
        .await?;
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let mut host = reqwest::Client::new()
        .get(format!("{}/internal/browser-host", s.gw.base))
        .bearer_auth(&s.gw.token)
        .header("x-butler-admin", &admin.admin)
        .send()
        .await?;
    assert_eq!(host.status(), 200);
    s.turn("general", stub::OWNER).await?;
    // Lose the host once the Steward's browser call reaches it.
    let mut frames = String::new();
    while !frames.contains("tab.open") {
        let chunk = tokio::time::timeout(Duration::from_secs(20), host.chunk())
            .await
            .unwrap_or_else(|_| panic!("no tab.open frame\n{}", s.agent.logs()))?
            .unwrap();
        frames.push_str(std::str::from_utf8(&chunk).unwrap());
    }
    drop(host);
    wait_answer(&s).await?;
    let requests = script.requests.lock().unwrap().clone();
    let opened = output(&requests, "open");
    assert!(
        matches!(
            opened["reason"].as_str(),
            Some("browser_host_lost" | "timeout")
        ),
        "{opened}"
    );
    // A hand-back of a granted tool is model feedback, not a turn interruption.
    let handoff = output(&requests, "handoff");
    assert_eq!(handoff["ok"], false, "{handoff}");
    assert_eq!(handoff["error"]["code"], "capability_handoff_rejected");
    assert!(
        requests.iter().any(|request| {
            let text = request.to_string();
            text.contains("Delegated result") && text.contains("status: blocked")
        }),
        "the parent result Turn carries the blocked child result"
    );
    let logs = s.agent.logs();
    assert!(!logs.contains("code=capability_handoff_rejected"), "{logs}");
    let db =
        butler_platform::sqlite::open(s.sandbox.data.join("agent-runtime/btcc.sqlite")).unwrap();
    let status: String = db
        .query_row("SELECT status FROM btcc_steward_results", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(status, "blocked");
    drop(db);
    s.finish().await?;
    server.abort();
    Ok(())
}

/// The model-facing result of one scripted call, as the next request carries it
/// (unwrapping a tool envelope's `output` object when present).
fn output(requests: &[Value], call_id: &str) -> Value {
    let result: Value = requests
        .iter()
        .flat_map(|request| request["input"].as_array().cloned().unwrap_or_default())
        .find(|item| item["type"] == "function_call_output" && item["call_id"] == call_id)
        .and_then(|item| serde_json::from_str(item["output"].as_str()?).ok())
        .unwrap_or_else(|| panic!("no output for {call_id}"));
    match result.get("output") {
        Some(inner) if inner.is_object() => inner.clone(),
        _ => result,
    }
}

async fn wait_answer(s: &butler_e2e::e2e::scenario::Scenario) -> Result<(), HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let messages = s.gw.messages("general").await?;
        if messages.iter().any(|message| {
            message["role"] == "assistant"
                && message["text"] == stub::ANSWER
                && message["status"] == "delivered"
        }) {
            return Ok(());
        }
        assert!(
            Instant::now() < deadline,
            "parent never answered: {messages:?}\n{}",
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}
