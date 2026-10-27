//! S3: real consolidation, pattern management and durable user preferences.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "E2E assertions"
)]
use butler_e2e::e2e::{
    HarnessError,
    cassette::{Cassette, ResponseRecord},
    provider::title_response,
    scenario::{Scenario, Setup},
};
use serde_json::{Value, json};
use std::time::Duration;
mod actions;
mod readiness;
mod settings;
mod validation;

pub(super) fn task(request: &Value) -> Value {
    let text = request["input"]
        .as_str()
        .or_else(|| request["input"][0]["content"][0]["text"].as_str())
        .unwrap_or("");
    serde_json::from_str(text).unwrap_or(Value::Null)
}
fn update(id: &Value, ids: &[Value]) -> Value {
    json!({"pattern_id":id,"title":"Morning research","intent":"Prepare a morning report",
        "window":{"days":["mon","tue","wed","thu","fri"],"start":"07:30","end":"08:30"},"evidence_ids":ids})
}
fn candidate(id: &Value) -> Value {
    json!({"pattern_id":id,"title":"Prepare your morning report", "action":{"title":"Morning report",
        "prompt":"Research and summarize the latest information.","schedule":{"type":"weekdays","time":"07:25"}}})
}
pub(super) fn responder(request: &Value) -> Option<ResponseRecord> {
    let task = task(request);
    let content = match task["task"].as_str() {
        Some("pattern_extraction") => {
            let ids: Vec<_> = task["events"]
                .as_array()?
                .iter()
                .map(|e| e["id"].clone())
                .collect();
            let removed = task["removed"][0]["id"].clone();
            let existing = task["patterns"][0]["id"].clone();
            let first = if removed.is_null() { existing } else { removed };
            let (a, b): (Vec<_>, Vec<_>) =
                ids.into_iter().enumerate().partition(|(i, _)| i % 2 == 0);
            json!({"updates":[update(&first, &a.into_iter().map(|(_, id)|id).collect::<Vec<_>>()),
                update(&Value::Null, &b.into_iter().map(|(_, id)|id).collect::<Vec<_>>())]})
        }
        Some("pattern_proposal") => {
            let ids: Vec<_> = if task["removed"][0]["id"].is_string() {
                vec![task["removed"][0]["id"].clone()]
            } else {
                task["patterns"]
                    .as_array()?
                    .iter()
                    .map(|p| p["id"].clone())
                    .collect()
            };
            json!({"candidates":ids.iter().map(candidate).collect::<Vec<_>>()})
        }
        _ => {
            return super::briefing_effort::briefing(request)
                .or_else(|| Some(title_response(r#"{"candidates":[]}"#)));
        }
    };
    Some(title_response(&format!("```json\n{content}\n```")))
}
pub(super) async fn setup(id: &str) -> Result<Scenario, HarnessError> {
    let mut cassette = Cassette::load("TOOL-01")?;
    cassette.exchanges.clear();
    let setup = Setup::new(id)?
        .stub_cassette(cassette)
        .env("TZ", "UTC")
        .env("BUTLER_MEMORY_SYNC_TRACE", "1")
        .env("BUTLER_E2E_APP_NOW", "2026-10-26T03:59:00.000Z");
    super::memory_fixture::initialize_empty(&setup.sandbox.data)?;
    let s = setup.start().await?;
    s.provider()?.set_chat_responder(responder);
    Ok(s)
}
pub(super) fn seed(s: &Scenario, start: usize, count: usize) -> Result<(), HarnessError> {
    let db =
        butler_platform::sqlite::open(s.sandbox.data.join("runtime/conversation-store.sqlite"))?;
    db.execute("INSERT OR IGNORE INTO conversation_sessions(id,gateway_origin,created_at,updated_at,status,schema_version) VALUES('pattern-source','app','2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z','active',6)", [])?;
    for n in start..start + count {
        let day = if n < 8 {
            2 + n / 2 * 7
        } else {
            24 + (n - 8) / 2
        };
        let at = format!("2026-10-{day:02}T07:48:00.000Z");
        let id = format!("pattern-event-{n:04}");
        db.execute("INSERT INTO conversation_messages(id,session_id,seq,role,status,visibility,provenance,created_at,origin_kind) VALUES(?1,'pattern-source',?2,'user','complete','user','imported',?3,'user_input')", rusqlite::params![id,n,at])?;
        db.execute("INSERT INTO conversation_parts(id,message_id,part_index,kind,content_json,status) VALUES(?1,?2,0,'text',?3,'complete')", rusqlite::params![format!("{id}-text"),id,json!({"text":"Research today's information."}).to_string()])?;
    }
    Ok(())
}
pub(super) async fn enable(s: &Scenario) -> Result<(), HarnessError> {
    let r =
        s.gw.patch("/personalization", json!({"profiling":{"mode":"basic"}}))
            .await?;
    assert_eq!(r.status, 200, "{}", r.text);
    Ok(())
}
// Consolidation also calls the source consumer directly. Its coordinator inspection
// is a diagnostic, not a consumer state transition, and may follow the idle park.
async fn parked(s: &Scenario) {
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let logs = s.agent.current_logs().await.unwrap();
            let state = logs.lines().rfind(|line| {
                line.contains("[memory-sync-trace]") && !line.contains("coordinator=")
            });
            if state.is_some_and(|line| line.ends_with("park delay=None")) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("source consumer parked after its last state transition");
}
pub(super) async fn run(s: &Scenario) -> Result<Value, HarnessError> {
    run_phase(s, "complete").await
}
async fn run_phase(s: &Scenario, phase: &str) -> Result<Value, HarnessError> {
    readiness::settle(s).await?;
    parked(s).await;
    let id = uuid::Uuid::new_v4().to_string();
    let r =
        s.gw.post("/memory/consolidation", json!({"operation_id":id}))
            .await?;
    assert_eq!(r.status, 202, "{}", r.text);
    tokio::time::timeout(Duration::from_secs(90), async {
        loop {
            for event in s.gw.events_since(0).await? {
                let p = &event["payload"];
                if event["type"] == "memory.operation"
                    && p["operation_id"] == id
                    && p["sequence"] == 2
                {
                    if p["phase"] != phase {
                        let report: Value = serde_json::from_slice(&std::fs::read(
                            s.sandbox
                                .data
                                .join(format!("cognition/consolidation/runs/{id}.json")),
                        )?)?;
                        for item in report["phases"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .filter(|item| item["status"] == "error")
                        {
                            eprintln!(
                                "consolidation phase={} error={}",
                                item["phase"], item["error"]
                            );
                        }
                    }
                    assert_eq!(p["phase"], phase, "{event}");
                    readiness::settle(s).await?;
                    parked(s).await;
                    return Ok(read_store(s));
                }
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("consolidation terminal event")
}
fn read_store(s: &Scenario) -> Value {
    std::fs::read(s.sandbox.data.join("cognition/patterns/patterns.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null)
}
fn requests(s: &Scenario, name: &str) -> Vec<Value> {
    s.provider()
        .unwrap()
        .requests()
        .iter()
        .map(task)
        .filter(|t| t["task"] == name)
        .collect()
}
#[tokio::test]
async fn learning_off_does_not_create_notes_or_call_pattern_models() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = setup("PATTERNS-OFF").await?;
    seed(&s, 0, 8)?;
    assert_eq!(
        s.gw.patch("/personalization", json!({"profiling":{"mode":"off"}}))
            .await?
            .status,
        200
    );
    assert_eq!(
        s.gw.get("/memory/patterns").await?.data(),
        &json!({"revision":0,"patterns":[]})
    );
    run(&s).await?;
    assert!(read_store(&s).is_null());
    assert_eq!(requests(&s, "pattern_extraction"), Vec::<Value>::new());
    assert_eq!(requests(&s, "pattern_proposal"), Vec::<Value>::new());
    s.finish().await
}
#[tokio::test]
async fn proactive_off_still_extracts_without_proposals() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = setup("PATTERNS-PROACTIVE-OFF").await?;
    seed(&s, 0, 8)?;
    enable(&s).await?;
    assert_eq!(
        s.gw.patch("/settings", json!({"proactive_level":"off"}))
            .await?
            .status,
        200
    );
    let store = run(&s).await?;
    assert_eq!(store["patterns"].as_array().unwrap().len(), 2);
    assert_eq!(store["bundles"], json!([]));
    assert_eq!(requests(&s, "pattern_proposal"), Vec::<Value>::new());
    s.finish().await
}
