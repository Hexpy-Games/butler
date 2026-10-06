//! Completion-window acceptance through the real parent provider request.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "E2E assertions")]
use butler_e2e::e2e::{HarnessError, cassette::Cassette, scenario::Setup};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

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
    let end = text.find("## Runtime State").unwrap();
    let mut bytes =
        serde_json::to_vec(&json!([request["instructions"], request["tools"]])).unwrap();
    bytes.extend_from_slice(text[..end].trim_end().as_bytes());
    bytes
}
fn history(data: &std::path::Path) -> String {
    let db = Connection::open(data.join("agent-runtime/btcc.sqlite")).unwrap();
    db.query_row("SELECT content FROM btcc_context_documents WHERE source_id='recent-conversation' ORDER BY rowid DESC LIMIT 1", [], |row| row.get(0)).unwrap_or_default()
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
        .env("BUTLER_E2E_HOLD_MEMORY_BOOTSTRAP", "1");
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
            "History request {index}: {}end",
            "preserve this request ".repeat(40)
        );
        let request_index = stub.requests.lock().unwrap().len();
        let (_, turn) = s.turn("general", &ask).await?;
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
            "bytes":serde_json::to_vec(&request)?.len(),"move":moved}));
        let sections = loaded_sections(&s.sandbox.data, &request, &placeholders)?;
        captured.push(json!({"request": request, "sections": sections, "wire_bytes":turn_requests.iter().map(|request| serde_json::to_vec(request).unwrap().len()).sum::<usize>(),
            "instructions":placeholders.hide(request["instructions"].as_str().unwrap())}));
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
    if let Ok(directory) = std::env::var("BUTLER_PROMPT_CAPTURE_DIR") {
        std::fs::create_dir_all(&directory)?;
        std::fs::write(
            std::path::Path::new(&directory).join(format!("heavy-{heavy}.json")),
            serde_json::to_vec(&captured)?,
        )?;
    }
    if verify {
        compare_golden(&format!("heavy-{heavy}"), &captured)?;
    }
    let db = Connection::open(s.sandbox.data.join("runtime/conversation-store.sqlite"))?;
    let writes: u64 = db.query_row("SELECT COUNT(*) FROM conversation_summaries", [], |row| {
        row.get(0)
    })?;
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_eq!(
        writes,
        db.query_row::<u64, _, _>("SELECT COUNT(*) FROM conversation_summaries", [], |row| row
            .get(0))?
    );
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
    let Ok(directory) = std::env::var("BUTLER_PROMPT_GOLDEN_DIR") else {
        return Ok(());
    };
    let main: Vec<Value> = serde_json::from_slice(&std::fs::read(
        std::path::Path::new(&directory).join(format!("{case}.json")),
    )?)?;
    for index in (0..requests.len()).filter(|index| *index == 0 || *index + 1 == requests.len()) {
        let main_bytes = main[index]["wire_bytes"].as_u64().unwrap();
        let branch_bytes = requests[index]["wire_bytes"].as_u64().unwrap();
        eprintln!(
            "PROMPT_PARITY case={case} turn={index} main_bytes={main_bytes} branch_bytes={branch_bytes}"
        );
        assert!(branch_bytes <= main_bytes);
        let main_text = source(&main[index]["request"]);
        for line in source(&requests[index]["request"]).lines() {
            if line.starts_with("user: History request ") || line == "butler: once" {
                assert!(
                    main_text.contains(line),
                    "history content absent from main: {line}"
                );
            }
        }
        assert_eq!(main[index]["instructions"], requests[index]["instructions"]);
        assert_eq!(main[index]["sections"], requests[index]["sections"]);
        assert_eq!(
            main[index]["request"]["tools"],
            requests[index]["request"]["tools"]
        );
    }
    Ok(())
}

fn loaded_sections(
    data: &std::path::Path,
    request: &Value,
    placeholders: &butler_e2e::e2e::sanitize::Placeholders,
) -> Result<Value, HarnessError> {
    let db = Connection::open(data.join("agent-runtime/btcc.sqlite"))?;
    let mut query = db.prepare("SELECT source_id,content FROM btcc_context_documents WHERE rowid IN (SELECT MAX(rowid) FROM btcc_context_documents GROUP BY source_id) ORDER BY source_id")?;
    let mut sections = serde_json::Map::new();
    let prompt = format!(
        "{}\n{}",
        request["instructions"].as_str().unwrap(),
        source(request)
    );
    for row in query.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })? {
        let (id, content) = row?;
        if id == "recent-conversation" {
            continue;
        }
        let loaded = super::agent_context::loaded_excerpt(&id, &content, &prompt);
        let normalized = placeholders
            .hide(&loaded)
            .lines()
            .map(|line| {
                for field in [
                    "Current Time UTC:",
                    "Current Local Time:",
                    "Live Configuration Hash:",
                ] {
                    if line.starts_with(field) {
                        return format!("{field} {{{{PER_RUN}}}}");
                    }
                }
                line.to_owned()
            })
            .collect::<Vec<_>>()
            .join("\n");
        sections.insert(id, normalized.into());
    }
    Ok(Value::Object(sections))
}

#[tokio::test]
async fn late_completion_is_appended_with_identity_and_timestamp() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, stub, server) = provider::start(false).await?;
    let s = Setup::new("PROMPT-LATE")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", url)
        .env("BUTLER_E2E_HOLD_MEMORY_BOOTSTRAP", "1")
        .start()
        .await?;
    s.turn("general", "first ordinary request").await?;
    let db = Connection::open(s.sandbox.data.join("runtime/conversation-store.sqlite"))?;
    seed_late(&db)?;
    for index in 0..6 {
        s.turn("general", &format!("ordinary request {index}"))
            .await?;
    }
    let previous = prefix(stub.requests.lock().unwrap().last().unwrap());
    let timestamp = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    db.execute(
        "UPDATE conversation_turns SET status='complete',completed_at=?1 WHERE id='ct_late'",
        [&timestamp],
    )?;
    s.turn("general", "after late completion").await?;
    let requests = stub.requests.lock().unwrap().clone();
    let request = requests.last().unwrap();
    assert!(prefix(request).starts_with(&previous));
    let text = source(request);
    assert!(text.contains(&format!(
        "turn ct_late status complete completed {timestamp}"
    )));
    assert!(text.find("ordinary request 5").unwrap() < text.find("late user request").unwrap());
    assert!(text.contains("butler: late final reply"));
    s.finish().await?;
    server.abort();
    Ok(())
}

fn seed_late(db: &Connection) -> Result<(), HarnessError> {
    let session: String =
        db.query_row("SELECT id FROM conversation_sessions LIMIT 1", [], |row| {
            row.get(0)
        })?;
    let turn_seq: u64 = db.query_row("SELECT MAX(seq)+1 FROM conversation_turns", [], |row| {
        row.get(0)
    })?;
    let seq: u64 = db.query_row("SELECT MAX(seq)+1 FROM conversation_messages", [], |row| {
        row.get(0)
    })?;
    db.execute("INSERT INTO conversation_turns(id,session_id,seq,actor,status,started_at) VALUES('ct_late',?1,?2,'user','running','2026-01-01T00:00:00Z')", rusqlite::params![session,turn_seq])?;
    for (offset, role, text) in [
        (0, "user", "late user request"),
        (1, "assistant", "late final reply"),
    ] {
        let id = format!("cm_late_{offset}");
        db.execute("INSERT INTO conversation_messages(id,session_id,turn_id,seq,role,status,visibility,provenance,created_at) VALUES(?1,?2,'ct_late',?3,?4,'complete','user','imported','2026-01-01T00:00:00Z')", rusqlite::params![id,session,seq+offset,role])?;
        db.execute("INSERT INTO conversation_parts(id,message_id,part_index,kind,content_json,status) VALUES(?1,?2,0,'text',?3,'complete')", rusqlite::params![format!("cp_late_{offset}"),id,json!({"text":text}).to_string()])?;
    }
    Ok(())
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
        scheduled_direct(&s, index).await?;
        let requests = stub.requests.lock().unwrap()[start..].to_vec();
        let request = &requests[0];
        let current = prefix(request);
        if verify && index > 0 {
            assert!(current.starts_with(&previous));
        }
        previous = current;
        captured.push(json!({"request":request, "sections":loaded_sections(&s.sandbox.data,request,&placeholders)?,
            "instructions":placeholders.hide(request["instructions"].as_str().unwrap()),
            "wire_bytes":requests.iter().map(|request| serde_json::to_vec(request).unwrap().len()).sum::<usize>()}));
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
) -> Result<(), HarnessError> {
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
            return Ok(());
        }
        assert!(
            std::time::Instant::now() < deadline,
            "Direct schedule did not settle"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

pub(super) fn resume_parity(s: &butler_e2e::e2e::scenario::Scenario) -> Result<(), HarnessError> {
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
    let request = requests.last().unwrap();
    let mut placeholders = butler_e2e::e2e::sanitize::Placeholders::default();
    placeholders.add("W", s.sandbox.workspace.display().to_string());
    placeholders.add("D", s.sandbox.data.display().to_string());
    placeholders.add("SANDBOX", s.sandbox.root.display().to_string());
    let captured = vec![json!({"request":request,
        "instructions":placeholders.hide(request["instructions"].as_str().unwrap()),
        "sections":loaded_sections(&s.sandbox.data,request,&placeholders)?,
        "wire_bytes":serde_json::to_vec(request)?.len()})];
    if std::env::var("BUTLER_PROMPT_MAIN_RECORD").as_deref() == Ok("1") {
        let directory = std::env::var("BUTLER_PROMPT_CAPTURE_DIR").unwrap();
        std::fs::write(
            std::path::Path::new(&directory).join("resume.json"),
            serde_json::to_vec(&captured)?,
        )?;
    } else {
        compare_golden("resume", &captured)?;
    }
    Ok(())
}

#[path = "prompt_history_perf.rs"]
mod perf;
