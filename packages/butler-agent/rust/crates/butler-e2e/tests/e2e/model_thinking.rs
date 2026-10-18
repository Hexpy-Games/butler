//! Provider summaries travel through the real gateway without durable progress.
#![allow(clippy::unwrap_used, reason = "E2E assertions")]
use axum::{
    Json, Router,
    body::Body,
    extract::State,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use butler_e2e::e2e::{
    HarnessError,
    config::ModelChoice,
    events::LiveEvents,
    scenario::{Scenario, Setup},
};
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::Notify;

const FIRST: &str = "Planning the search";
const SECOND: &str = "Checking the results";
const SIGNATURE: &str = "c3R1Yi1zaWduYXR1cmU=";
const WAIT: Duration = Duration::from_secs(20);
#[derive(Clone)]
struct Stub {
    provider: &'static str,
    raw: bool,
    reject_summary: bool,
    gate: Arc<Notify>,
    finish_gate: Arc<Notify>,
    requests: Arc<Mutex<Vec<Value>>>,
}
struct Server(tokio::task::JoinHandle<()>);
impl Drop for Server {
    fn drop(&mut self) {
        self.0.abort();
    }
}

mod stub;
use stub::{setup, setup_refusal};

fn row_counts(s: &Scenario) -> Result<(i64, i64), HarnessError> {
    let app = rusqlite::Connection::open_with_flags(
        s.sandbox.data.join("app-server/butler-client.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let btcc = rusqlite::Connection::open_with_flags(
        s.sandbox.data.join("agent-runtime/btcc.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    Ok((
        app.query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0))?,
        btcc.query_row("SELECT COUNT(*) FROM btcc_progress_events", [], |row| {
            row.get(0)
        })?,
    ))
}
async fn summary_case(provider: &'static str, show: bool) -> Result<(), HarnessError> {
    let (s, stub, _server) = setup(provider, false).await?;
    let saved = if show {
        s.gw.patch("/settings", json!({"show_thinking":true}))
            .await?
    } else {
        s.gw.get("/settings").await?
    };
    assert_eq!(saved.status, 200, "{}", saved.text);
    assert_eq!(saved.data()["show_thinking"], show);
    let live = LiveEvents::subscribe(&s.gw, 0).await?;
    s.gw.say("general", "Reply briefly.").await?;
    if provider == "openai" {
        live.wait_for(WAIT, |e| {
            e["type"] == "turn.thinking" && e["payload"]["line"] == "A link"
        })
        .await?;
        let capped = live
            .wait_for(WAIT, |e| {
                e["type"] == "turn.thinking" && e["payload"]["line"] == "😀".repeat(60)
            })
            .await?;
        assert_eq!(
            capped["payload"]["line"]
                .as_str()
                .unwrap()
                .encode_utf16()
                .count(),
            120
        );
        assert!(
            !live
                .snapshot()
                .iter()
                .any(|e| e["payload"]["line"] == "unfinished")
        );
    }
    let first = live
        .wait_for(WAIT, |e| {
            e["type"] == "turn.thinking" && e["payload"]["line"] == FIRST
        })
        .await?;
    assert!(first.get("id").is_none());
    let first_seen = std::time::Instant::now();
    let before = row_counts(&s)?;
    let second = live
        .wait_for(WAIT, |e| {
            e["type"] == "turn.thinking" && e["payload"]["line"] == SECOND
        })
        .await?;
    if provider == "openai" {
        assert!(
            first_seen.elapsed() >= Duration::from_millis(950),
            "line updates must wait one second"
        );
        let lines: Vec<_> = live
            .snapshot()
            .into_iter()
            .filter(|e| e["type"] == "turn.thinking")
            .map(|e| e["payload"]["line"].clone())
            .collect();
        assert_eq!(
            lines.iter().filter(|line| **line == FIRST).count(),
            1,
            "unchanged heading must not publish"
        );
        assert!(
            !lines.contains(&json!("Superseded")),
            "latest pending heading wins"
        );
    }
    assert_eq!(before, row_counts(&s)?, "thinking must not write rows");
    let expected = format!("**{FIRST}**\nDetails.\n**{SECOND}**\nMore details.\n");
    if show {
        assert_eq!(second["payload"]["summary"], expected);
        assert!(expected.len() <= 16 * 1024);
    } else {
        for event in live
            .snapshot()
            .iter()
            .filter(|e| e["type"] == "turn.thinking")
        {
            assert!(event["payload"].get("summary").is_none());
        }
    }
    assert_eq!(
        stub.requests.lock().unwrap().len(),
        1,
        "tool frame is still gated"
    );
    let reconnect = LiveEvents::subscribe(&s.gw, 0).await?;
    let snapshot = reconnect
        .wait_for(WAIT, |e| {
            e["type"] == "turn.thinking" && e["payload"]["line"] == SECOND
        })
        .await?;
    assert_eq!(
        snapshot["payload"].get("summary"),
        show.then(|| json!(expected)).as_ref()
    );
    assert_eq!(
        reconnect
            .snapshot()
            .iter()
            .filter(|e| e["type"] == "turn.thinking")
            .count(),
        1
    );
    stub.gate.notify_one();
    let turn = second["payload"]["turn_id"].as_str().unwrap();
    live.wait_for(WAIT, |e| {
        e["type"] == "turn.thinking"
            && e["payload"]["turn_id"] == turn
            && e["payload"]["line"].is_null()
    })
    .await?;
    let current = s.gw.turn("general", turn).await?.unwrap();
    assert_eq!(
        current["state"], "thinking",
        "text/tool start clears before delivery"
    );
    stub.finish_gate.notify_one();
    live.wait_turn(&s.gw, "general", turn, &["delivered"], WAIT)
        .await?;
    let events = live.snapshot();
    let second_at = events
        .iter()
        .position(|e| e["type"] == "turn.thinking" && e["payload"]["line"] == SECOND)
        .unwrap();
    assert!(
        events
            .iter()
            .skip(second_at + 1)
            .any(|e| e["type"] == "turn.thinking" && e["payload"]["line"].is_null()),
        "text/tool start must clear the line"
    );
    let ended = LiveEvents::subscribe(&s.gw, 0).await?;
    ended
        .wait_for(WAIT, |e| e["type"] == "answer_blocks.snapshot")
        .await?;
    assert!(
        !ended
            .snapshot()
            .iter()
            .any(|e| e["type"] == "turn.thinking")
    );
    let messages = s.gw.messages("general").await?;
    for heading in [FIRST, SECOND] {
        assert!(!json!(messages).to_string().contains(heading));
        assert!(!s.agent.logs().contains(heading));
    }
    assert_no_durable_summary(&s)?;
    assert_wire(&stub);
    eprintln!(
        "{provider}: show={show}; opt_in_summary_bytes={:?}; durable rows {before:?} unchanged; reconnect snapshots=1; gated delivery verified",
        show.then_some(expected.len())
    );
    drop((live, reconnect, ended));
    s.finish().await
}
fn assert_no_durable_summary(s: &Scenario) -> Result<(), HarnessError> {
    for (path, table, column) in [
        ("app-server/butler-client.sqlite", "events", "payload_json"),
        (
            "agent-runtime/btcc.sqlite",
            "btcc_progress_events",
            "event_json",
        ),
    ] {
        let db = rusqlite::Connection::open_with_flags(
            s.sandbox.data.join(path),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        for heading in [FIRST, SECOND] {
            let count: i64 = db.query_row(
                &format!("SELECT COUNT(*) FROM {table} WHERE instr({column}, ?1)>0"),
                [heading],
                |row| row.get(0),
            )?;
            assert_eq!(count, 0, "summary text persisted in {table}");
        }
    }
    Ok(())
}
fn assert_wire(stub: &Stub) {
    let requests = stub.requests.lock().unwrap();
    let first = &requests[0];
    match stub.provider {
        "google" => {
            assert_eq!(
                first["generationConfig"]["thinkingConfig"]["includeThoughts"],
                true
            );
            assert!(first["generationConfig"]["thinkingConfig"]["thinkingLevel"].is_string());
            let replay = requests[1]["contents"]
                .as_array()
                .unwrap()
                .iter()
                .find(|c| c["role"] == "model")
                .unwrap();
            assert_eq!(
                replay["parts"],
                json!([
                {"text":format!("**{FIRST}**\nDetails.\n**{SECOND}**\nMore details.\n"),"thought":true},
                {"functionCall":{"name":"tool_describe","args":{"ids":["native:list_tool_capabilities"]}},"thoughtSignature":SIGNATURE}])
            );
        }
        "anthropic" => assert_eq!(first["thinking"]["display"], "summarized"),
        _ => assert_eq!(first["reasoning"]["summary"], "auto"),
    }
}
#[tokio::test]
async fn gemini_summary_is_live_only_and_replayed() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    summary_case("google", false).await
}
#[tokio::test]
async fn anthropic_summary_is_live_only() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    summary_case("anthropic", false).await
}
#[tokio::test]
async fn responses_summary_is_live_only() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    summary_case("openai", false).await
}
#[tokio::test]
async fn full_summary_is_opt_in_live_only() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    summary_case("google", true).await
}
#[tokio::test]
async fn responses_internal_reasoning_never_reaches_app() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, stub, _server) = setup("openai", true).await?;
    assert_eq!(
        s.gw.patch("/settings", json!({"show_thinking":true}))
            .await?
            .status,
        200
    );
    let live = LiveEvents::subscribe(&s.gw, 0).await?;
    stub.gate.notify_one();
    stub.finish_gate.notify_one();
    let (_, turn) = s.turn("general", "Reply briefly.").await?;
    assert_eq!(turn["state"], "delivered");
    assert!(
        !live
            .snapshot()
            .iter()
            .any(|e| e["type"] == "turn.thinking" && e["payload"]["line"].is_string())
    );
    drop(live);
    s.finish().await
}

#[tokio::test]
async fn openai_summary_rejection_resends_once_and_is_remembered() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, stub, _server) = setup_refusal("openai", false, true).await?;
    for _ in 0..2 {
        stub.gate.notify_one();
        stub.finish_gate.notify_one();
        let (_, turn) = s.turn("general", "Reply briefly.").await?;
        assert_eq!(turn["state"], "delivered", "{turn}");
    }
    let requests = stub.requests.lock().unwrap().clone();
    assert_eq!(
        requests.len(),
        3,
        "one rejected request and two accepted rounds"
    );
    assert_eq!(requests[0]["reasoning"]["summary"], "auto");
    for request in &requests[1..] {
        assert!(request["reasoning"].get("summary").is_none());
    }
    s.finish().await
}
