//! Completion-window acceptance through the real parent provider request.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "E2E assertions")]
use butler_e2e::e2e::{HarnessError, cassette::Cassette, scenario::Setup};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

#[path = "prompt_history_golden.rs"]
mod golden;
#[path = "prompt_history_late.rs"]
mod late;

mod provider {
    use super::*;
    use axum::{Json, Router, extract::State, response::IntoResponse, routing::post};
    pub(super) struct Stub {
        pub requests: Mutex<Vec<Value>>,
        pub heavy: bool,
    }
    pub(super) async fn start(
        heavy: bool,
    ) -> Result<(String, Arc<Stub>, tokio::task::JoinHandle<()>), HarnessError> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let url = format!("http://{}/codex", listener.local_addr()?);
        let stub = Arc::new(Stub {
            requests: Mutex::new(vec![]),
            heavy,
        });
        let app = Router::new()
            .route("/codex/responses", post(reply))
            .with_state(stub.clone());
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Ok((url, stub, server))
    }
    async fn reply(
        State(stub): State<Arc<Stub>>,
        Json(body): Json<Value>,
    ) -> axum::response::Response {
        stub.requests.lock().unwrap().push(body.clone());
        let tool_round = body["input"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["type"] == "function_call_output");
        let item = if stub.heavy && !tool_round {
            json!({"type":"function_call","id":"fc_history","call_id":"call_history", "name":"read_file",
                "arguments":json!({"requests":[{"path":"history-output.txt"}]}).to_string(),"status":"completed"})
        } else {
            json!({"type":"message","id":"msg_history","role":"assistant","status":"completed",
                "content":[{"type":"output_text","text":"once","annotations":[]}]})
        };
        (
            [("content-type", "text/event-stream")],
            super::super::token_cache::wire(&item),
        )
            .into_response()
    }
}

fn source(request: &Value) -> &str {
    request["input"][0]["content"][0]["text"].as_str().unwrap()
}
fn prefix(request: &Value) -> Vec<u8> {
    let text = source(request);
    // Runtime state follows the stable documents and completion-ordered history.
    let end = text
        .find("## Current turn context")
        .or_else(|| text.find("## Runtime State"))
        .unwrap();
    let mut bytes =
        serde_json::to_vec(&json!([request["instructions"], request["tools"]])).unwrap();
    bytes.extend_from_slice(text[..end].trim_end().as_bytes());
    bytes
}
fn history(data: &std::path::Path) -> String {
    let db = Connection::open(data.join("agent-runtime/btcc.sqlite")).unwrap();
    db.query_row("SELECT content FROM btcc_context_documents WHERE source_id='recent-conversation' ORDER BY rowid DESC LIMIT 1", [], |row| row.get::<_,String>(0)).map(|text| serde_json::from_str::<Value>(text.strip_prefix("## Recent Conversation\n\n").unwrap_or(&text)).ok().and_then(|v|v["history"].as_str().map(str::to_owned)).unwrap_or(text)).unwrap_or_default()
}

#[tokio::test]
async fn completion_history_prefix_ordinary_and_tool_heavy() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for heavy in [false, true] {
        run(heavy, true).await?;
    }
    Ok(())
}

async fn run(heavy: bool, verify: bool) -> Result<(), HarnessError> {
    let (url, stub, server) = provider::start(heavy).await?;
    let setup = Setup::new("PROMPT-HISTORY")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", url)
        .env("BUTLER_E2E_HOLD_MEMORY_BOOTSTRAP", "1")
        .env(
            "BUTLER_E2E_DB_LOAD",
            std::env::var("BUTLER_E2E_DB_LOAD").unwrap_or_default(),
        )
        .env(
            "BUTLER_E2E_VERIFY_HISTORY_WRITES",
            if verify { "1" } else { "0" },
        );
    std::fs::write(
        setup.sandbox.data.join("history-output.txt"),
        "tool output ".repeat(1490),
    )?;
    let placeholders = setup.placeholders.clone();
    let s = setup.start().await?;
    let mut previous = Vec::new();
    let mut previous_history = String::new();
    let mut asks = Vec::new();
    let mut moves = Vec::new();
    let mut measurements = Vec::new();
    let mut captured = Vec::new();
    for index in 0..16 {
        let ask = format!(
            "History request {index}: {}한글 é 😀 \"quote\" \\ end",
            "preserve this request ".repeat(40)
        );
        let request_index = stub.requests.lock().unwrap().len();
        let (turn_id, turn) = s.turn("general", &ask).await?;
        assert_eq!(turn["state"], "delivered", "{turn}");
        let turn_requests = stub.requests.lock().unwrap()[request_index..].to_vec();
        if heavy {
            assert!(
                turn_requests
                    .iter()
                    .skip(1)
                    .any(|request| request["input"].to_string().len() >= 16000),
                "tool output never reached 16KB at turn {index}"
            );
        }
        let request = turn_requests[0].clone();
        let current = prefix(&request);
        if verify {
            let text = source(&request);
            for heading in [
                "## Recent conversation and feedback",
                "## Required working context",
                "## Optional working context",
                "## Conversation history",
                "## Current turn context",
                "## Current request",
            ] {
                assert_eq!(
                    text.matches(heading).count(),
                    1,
                    "fixed heading {heading} at turn {index}"
                );
            }
            assert!(text.ends_with(&ask));
        }

        let content = history(&s.sandbox.data);
        let moved = !previous_history.is_empty() && !content.starts_with(&previous_history);
        if moved {
            moves.push(index);
        }
        let common = previous
            .iter()
            .zip(&current)
            .take_while(|(a, b)| a == b)
            .count();
        if verify && index >= 2 && !moved {
            assert!(
                current.starts_with(&previous),
                "prefix changed at turn {index}, heavy={heavy}"
            );
        }
        for recent in asks.iter().rev().take(4) {
            assert!(
                source(&request).contains(recent),
                "newest request clipped at turn {index}"
            );
            let after = source(&request).split_once(recent).unwrap().1;
            let end = after.find("\nturn ").unwrap_or(after.len());
            assert!(
                after[..end].contains("\nbutler: once"),
                "newest final reply missing from its own turn at turn {index}"
            );
        }
        if !asks.is_empty() {
            assert!(source(&request).contains("butler: once"));
        }
        measurements.push(json!({"turn":index,"prefix_percent":if previous.is_empty(){0.0}else{100.0*common as f64/previous.len() as f64},
            "bytes":serde_json::to_vec(&request)?.len(),"stored_history_bytes":content.len(),"move":moved}));
        captured.push(golden::capture(
            &s.sandbox.data,
            &turn_id,
            &turn_requests,
            &placeholders,
        )?);
        previous = current;
        previous_history = content;
        asks.push(ask);
    }
    let intervals: Vec<_> = moves
        .windows(2)
        .map(|window| window[1] - window[0])
        .collect();
    assert!(
        !verify || intervals.iter().all(|interval| *interval > 1),
        "start moved every turn: {moves:?}"
    );
    eprintln!(
        "PROMPT_HISTORY heavy={heavy} moves={moves:?} intervals={intervals:?} measurements={measurements:?}"
    );
    let max_stored_history_bytes = measurements
        .iter()
        .filter_map(|measurement| measurement["stored_history_bytes"].as_u64())
        .max()
        .unwrap_or_default();
    eprintln!("PROMPT_HISTORY_STORAGE heavy={heavy} max_bytes={max_stored_history_bytes}");
    if let Ok(directory) = std::env::var("BUTLER_PROMPT_CAPTURE_DIR") {
        std::fs::create_dir_all(&directory)?;
        std::fs::write(
            std::path::Path::new(&directory).join(format!("heavy-{heavy}.json")),
            serde_json::to_vec(&captured)?,
        )?;
    }
    if verify {
        compare_golden(&format!("heavy-{heavy}"), &captured)?;
        let btcc = Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
        let content: String = btcc.query_row("SELECT content FROM btcc_context_documents WHERE source_id='recent-conversation' ORDER BY rowid DESC LIMIT 1", [], |r| r.get(0))?;
        assert!(!content.contains("mainBudgetProjection"));
        assert!(!content.trim_start().starts_with('{'));
        assert_eq!(content, history(&s.sandbox.data));
        assert!(
            !source(stub.requests.lock().unwrap().last().unwrap()).contains("漢漢 é 😀"),
            "budget surrogate must never reach the model"
        );
    }
    if verify {
        let log = std::fs::read_to_string(s.sandbox.logs.join("agent-1.log"))?;
        let changes: Vec<_> = log
            .lines()
            .filter_map(|line| line.split("[history-projection-writes] changes=").nth(1))
            .collect();
        assert!(changes.len() >= asks.len().saturating_sub(1));
        assert!(changes.iter().all(|line| line.trim() == "0"));
    }
    let db = Connection::open(s.sandbox.data.join("runtime/conversation-store.sqlite"))?;
    let writes: u64 = db.query_row("SELECT COUNT(*) FROM conversation_summaries", [], |row| {
        row.get(0)
    })?;
    assert_eq!(writes, 0, "assembly must not create summaries");
    assert_eq!(
        db.query_row::<u64, _, _>(
            "SELECT COUNT(*) FROM conversation_messages WHERE status='compacted'",
            [],
            |r| r.get(0)
        )?,
        0
    );
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_eq!(
        writes,
        db.query_row::<u64, _, _>("SELECT COUNT(*) FROM conversation_summaries", [], |row| row
            .get(0))?
    );
    if std::env::var("BUTLER_E2E_DB_LOAD").as_deref() == Ok("1") {
        let log = std::fs::read_to_string(s.sandbox.logs.join("agent-1.log"))?;
        for line in log.lines().filter(|line| line.contains("DB_LOAD ")) {
            eprintln!("PROMPT {line}");
        }
    }
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn record_main_prompt_golden() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    if std::env::var("BUTLER_PROMPT_MAIN_RECORD").as_deref() != Ok("1") {
        return Ok(());
    }
    for heavy in [false, true] {
        run(heavy, false).await?;
    }
    Ok(())
}

fn compare_golden(case: &str, requests: &[Value]) -> Result<(), HarnessError> {
    golden::compare(case, requests)
}

#[tokio::test]
async fn direct_phase_preserves_main_content() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    direct_case(true).await
}

#[tokio::test]
async fn record_main_direct_golden() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    if std::env::var("BUTLER_PROMPT_MAIN_RECORD").as_deref() != Ok("1") {
        return Ok(());
    }
    direct_case(false).await
}

async fn direct_case(verify: bool) -> Result<(), HarnessError> {
    let (url, stub, server) = provider::start(false).await?;
    let setup = Setup::new("PROMPT-DIRECT")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", url)
        .env("BUTLER_E2E_HOLD_MEMORY_BOOTSTRAP", "1");
    let placeholders = setup.placeholders.clone();
    let mut s = setup.start().await?;
    s.turn("general", "warm direct fixture").await?;
    s.agent.terminate().await?;
    Connection::open(s.sandbox.data.join("runtime/session-store.sqlite"))?.execute(
        "UPDATE session_bindings SET metadata_json=json_set(COALESCE(metadata_json,'{}'),'$.runtimePolicy.trackingMode','none','$.runtimePolicy.requiredNativeToolProfiles',json('[]'),'$.runtimePolicy.requiredNativeTools',json('[]'))", []
    )?;
    s.gw = s.agent.start_again().await?;
    let mut captured = Vec::new();
    let mut previous = Vec::new();
    for index in 0..2 {
        let start = stub.requests.lock().unwrap().len();
        let turn_id = scheduled_direct(&s, index).await?;
        let requests = stub.requests.lock().unwrap()[start..].to_vec();
        let request = &requests[0];
        let current = prefix(request);
        if verify && index > 0 {
            assert!(current.starts_with(&previous));
        }
        previous = current;
        captured.push(golden::capture(
            &s.sandbox.data,
            &turn_id,
            &requests,
            &placeholders,
        )?);
    }
    if verify {
        let rows = std::fs::read_to_string(
            s.sandbox
                .data
                .join("metrics/request-prefix-diagnostics.jsonl"),
        )?;
        assert!(
            rows.lines()
                .any(|line| serde_json::from_str::<Value>(line).unwrap()["phase"] == "direct")
        );
        compare_golden("direct", &captured)?;
    } else if let Ok(directory) = std::env::var("BUTLER_PROMPT_CAPTURE_DIR") {
        std::fs::create_dir_all(&directory)?;
        std::fs::write(
            std::path::Path::new(&directory).join("direct.json"),
            serde_json::to_vec(&captured)?,
        )?;
    }
    s.finish().await?;
    server.abort();
    Ok(())
}

async fn scheduled_direct(
    s: &butler_e2e::e2e::scenario::Scenario,
    index: usize,
) -> Result<String, HarnessError> {
    let id = format!("prompt-direct-{index}");
    let timestamp = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let record = json!({"version":1,"queueId":id,"enqueuedAt":timestamp,"attempts":0,"metadata":{},
        "envelope":{"eventId":id,"transport":"automation","accountId":"local",
            "peer":{"kind":"dm","id":"butler/app-general"},
            "sender":{"id":"butler-automation","displayName":"Butler Schedule"},
            "message":{"id":id,"text":format!("direct request {index}"),"timestamp":timestamp},
            "routingHints":{"sessionId":"butler/app-general","turnId":id}}});
    let root = s.sandbox.data.join("runtime/inbound-events");
    let temporary = root.join("pending").join(format!("{id}.tmp"));
    std::fs::write(&temporary, serde_json::to_vec(&record)?)?;
    std::fs::rename(temporary, root.join("pending").join(format!("{id}.json")))?;
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    loop {
        if let Ok(bytes) = std::fs::read(root.join("processed").join(format!("{id}.json"))) {
            let settled: Value = serde_json::from_slice(&bytes)?;
            assert_eq!(settled["metadata"]["delivered"], 1, "{settled}");
            let db = Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
            let context: String = db.query_row(
                "SELECT context_json FROM btcc_turns WHERE turn_id=?1",
                [&id],
                |row| row.get(0),
            )?;
            let context: Value = serde_json::from_str(&context)?;
            assert_eq!(context["executionPolicy"]["trackingMode"], "none");
            assert_eq!(
                context["executionPolicy"]["requiredNativeToolProfiles"],
                json!([])
            );
            return Ok(id);
        }
        assert!(
            std::time::Instant::now() < deadline,
            "Direct schedule did not settle"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

pub(super) fn resume_parity(
    s: &butler_e2e::e2e::scenario::Scenario,
    turn_id: &str,
) -> Result<(), HarnessError> {
    let requests = s.provider()?.requests();
    if std::env::var("BUTLER_PROMPT_MAIN_RECORD").as_deref() != Ok("1") {
        let previous = prefix(requests.first().unwrap());
        let current = prefix(requests.last().unwrap());
        assert!(
            current.starts_with(&previous),
            "resume stable prefix changed"
        );
        eprintln!("PROMPT_RESUME stable_prefix_percent=100");
    }
    golden::parity_case(s, turn_id, &requests, "delegated")
}

#[path = "prompt_history_perf.rs"]
mod perf;

#[path = "prompt_history_over_budget.rs"]
mod over_budget;

pub(super) fn approval_parity(
    s: &butler_e2e::e2e::scenario::Scenario,
    turn_id: &str,
    requests: &[Value],
) -> Result<(), HarnessError> {
    golden::parity_case(s, turn_id, requests, "resume")
}
