//! Shared canonical seeding, memory-gate holding and recall calls for the
//! inventory coverage scenarios. Seeds are written the way an external
//! writer would: plain SQL against the agent's live stores.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test fixture assertions"
)]

use super::memory_response;
use super::memory_stubs::graph_path;
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    scenario::{Scenario, Setup},
};
use butler_platform::sqlite;
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// A recall the stub model issues for one fixed prompt.
pub(super) struct Variant {
    pub prompt: &'static str,
    pub arguments: Value,
}

/// Starts the agent with one recall exchange per variant.
pub(super) async fn start(id: &str, variants: &[Variant]) -> Result<Scenario, HarnessError> {
    let mut cassette = Cassette::load("MEM-01")?;
    let mut added = Vec::new();
    for variant in variants {
        let mut call = cassette.exchanges[0].clone();
        call.request.key.user_request = variant.prompt.into();
        call.response = memory_response(&json!({"type":"function_call","id":"fc_coverage",
            "call_id":"call_coverage","name":"recall_memory","status":"completed",
            "arguments":variant.arguments.to_string()}));
        let mut answer = cassette.exchanges[1].clone();
        answer.request.key.user_request = variant.prompt.into();
        added.extend([call, answer]);
    }
    cassette.exchanges.extend(added);
    Setup::new(id)?
        .stub_cassette(cassette)
        .env("BUTLER_METRICS_ENABLED", "1")
        .start()
        .await
}

pub(super) fn canonical_path(data: &Path) -> PathBuf {
    data.join("runtime/conversation-store.sqlite")
}

pub(super) fn canonical(data: &Path) -> sqlite::Connection {
    let db = sqlite::open(canonical_path(data)).unwrap();
    db.busy_timeout(Duration::from_secs(10)).unwrap();
    db
}

pub(super) fn graph(data: &Path) -> sqlite::Connection {
    let db = sqlite::open(graph_path(data).unwrap()).unwrap();
    db.busy_timeout(Duration::from_secs(10)).unwrap();
    db
}

pub(super) fn session(db: &Connection, id: &str, project: Option<&str>) {
    db.execute(
        "INSERT INTO conversation_sessions(id,project_id,gateway_origin,created_at,updated_at,status,schema_version) \
         VALUES(?1,?2,'app','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','active',6)",
        params![id, project],
    )
    .unwrap();
}

/// One delivered turn `n` of `session`: a user request and a public answer.
pub(super) fn turn(db: &Connection, session: &str, n: u64, text: &str, at: &str) -> String {
    let turn = format!("{session}-turn-{n}");
    db.execute(
        "INSERT INTO conversation_turns(id,session_id,seq,actor,status,started_at,completed_at) \
         VALUES(?1,?2,?3,'user','complete',?4,?4)",
        params![turn, session, n, at],
    )
    .unwrap();
    for (index, role, origin, body) in [
        (0, "user", "user_input", text.to_owned()),
        (1, "assistant", "assistant_public", format!("Noted: {text}")),
    ] {
        let message = format!("{turn}-{role}");
        db.execute(
            "INSERT INTO conversation_messages(id,session_id,turn_id,seq,role,status,visibility,provenance,created_at,origin_kind) \
             VALUES(?1,?2,?3,?4,?5,'complete','user','trusted',?6,?7)",
            params![message, session, turn, n * 2 + index, role, at, origin],
        )
        .unwrap();
        db.execute(
            "INSERT INTO conversation_parts(id,message_id,part_index,kind,content_json,status) \
             VALUES(?1,?2,0,'text',?3,'complete')",
            params![
                format!("{message}-part"),
                message,
                json!({"text": body}).to_string()
            ],
        )
        .unwrap();
    }
    db.execute(
        "INSERT INTO conversation_turn_outcomes(id,session_id,turn_id,generation,outcome,source_hash,request_message_id,\
         public_assistant_message_id,evidence_refs_json,unresolved_obligations_json,created_at) \
         VALUES(?1,?2,?3,1,'delivered','seed',?4,?5,'[]','[]',?6)",
        params![format!("{turn}-outcome"), session, turn, format!("{turn}-user"), format!("{turn}-assistant"), at],
    )
    .unwrap();
    published(db);
    turn
}

/// Moves the public source revision, as the store's own writers do.
pub(super) fn published(db: &Connection) {
    db.execute(
        "UPDATE conversation_public_source_state SET revision=revision+1 WHERE singleton=1",
        [],
    )
    .unwrap();
}

/// A recovered standalone user message (imported history).
pub(super) fn recovered(db: &Connection, session: &str, seq: u64, text: &str, at: &str) {
    let message = format!("{session}-recovered-{seq}");
    db.execute(
        "INSERT INTO conversation_messages(id,session_id,turn_id,seq,role,status,visibility,provenance,created_at,origin_kind) \
         VALUES(?1,?2,NULL,?3,'user','complete','user','imported',?4,'user_input')",
        params![message, session, seq, at],
    )
    .unwrap();
    db.execute(
        "INSERT INTO conversation_parts(id,message_id,part_index,kind,content_json,status) \
         VALUES(?1,?2,0,'text',?3,'complete')",
        params![
            format!("{message}-part"),
            message,
            json!({"text": text}).to_string()
        ],
    )
    .unwrap();
    published(db);
}

/// Holds the consolidation write gate: the memory consumer defers, so the
/// graph and its inventory mirror stay exactly as they are.
pub(super) fn hold_gate(data: &Path) -> sqlite::Connection {
    let gate =
        sqlite::open(data.join("cognition/consolidation/locks/consolidation.lock.coord.sqlite"))
            .unwrap();
    gate.busy_timeout(Duration::from_secs(30)).unwrap();
    gate.execute_batch("BEGIN IMMEDIATE").unwrap();
    gate
}

pub(super) fn release_gate(gate: &sqlite::Connection) {
    gate.execute_batch("COMMIT").unwrap();
}

/// The canonical store's identity and change head.
pub(super) fn canonical_position(data: &Path) -> (String, i64) {
    let db =
        sqlite::open_with_flags(canonical_path(data), OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    db.query_row(
        "SELECT (SELECT identity FROM conversation_source_identity),(SELECT COALESCE(MAX(seq),0) FROM conversation_source_changes)",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .unwrap()
}

fn state(db: &Connection, key: &str) -> Option<String> {
    db.query_row(
        "SELECT value FROM memory_state WHERE key=?1",
        [key],
        |row| row.get(0),
    )
    .optional()
    .unwrap()
}

/// The mirror is built for this store and reflects every committed change.
pub(super) fn mirror_current(data: &Path) -> bool {
    let (identity, head) = canonical_position(data);
    let db = graph(data);
    state(&db, "canonical_inventory_phase").as_deref() == Some("ready")
        && state(&db, "canonical_inventory_identity").as_deref() == Some(identity.as_str())
        && state(&db, "canonical_inventory_seq").as_deref() == Some(head.to_string().as_str())
}

/// Waits until the inventory mirror and catch-up reflect every committed
/// store change and, when `projected`, every semantic job is complete.
pub(super) async fn settle(data: &Path, projected: bool) {
    tokio::time::timeout(Duration::from_secs(180), async {
        loop {
            let graph_path = graph_path(data).unwrap();
            let ready = mirror_current(data)
                && super::super::memory_idle::catchup_checkpoint_current(data, &graph_path)
                && (!projected
                    || graph(data)
                        .query_row(
                            "SELECT COUNT(*) FROM memory_projection_jobs WHERE json_extract(semantic_graph_state,'$.state')!='complete'",
                            [],
                            |row| row.get::<_, i64>(0),
                        )
                        .unwrap()
                        == 0);
            if ready {
                return;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("inventory mirror and projection did not settle");
}

/// Hides the mirror from recall (the next recall scans the whole store)
/// and returns the stored phase.
pub(super) fn hide_mirror(data: &Path) -> String {
    let db = graph(data);
    let phase = state(&db, "canonical_inventory_phase").unwrap();
    db.execute(
        "UPDATE memory_state SET value='hidden' WHERE key='canonical_inventory_phase'",
        [],
    )
    .unwrap();
    phase
}

pub(super) fn show_mirror(data: &Path, phase: &str) {
    graph(data)
        .execute(
            "UPDATE memory_state SET value=?1 WHERE key='canonical_inventory_phase'",
            [phase],
        )
        .unwrap();
}

/// The recall output of one stub-driven turn in `general`, and the
/// candidate-selection time the agent measured for it.
pub(super) async fn recall(s: &Scenario, variant: &Variant) -> Result<(Value, f64), HarnessError> {
    recall_in(s, "general", variant).await
}

/// A new chat for recall turns; each chat admits a bounded message rate.
pub(super) async fn chat(s: &Scenario, title: &str) -> Result<String, HarnessError> {
    let created =
        s.gw.post("/sessions", json!({"kind":"chat","title":title}))
            .await?;
    Ok(created.data()["session"]["id"].as_str().unwrap().to_owned())
}

/// [`recall`] from the chat `chat_id`.
pub(super) async fn recall_in(
    s: &Scenario,
    chat_id: &str,
    variant: &Variant,
) -> Result<(Value, f64), HarnessError> {
    let start = s.provider()?.requests().len();
    let started = std::time::Instant::now();
    let (_, turn) = s.turn(chat_id, variant.prompt).await?;
    eprintln!(
        "MEM-COVERAGE recall_turn_ms={}",
        started.elapsed().as_millis()
    );
    assert_eq!(turn["state"], "delivered", "{turn}");
    let requests = s.provider()?.requests();
    let output = requests[start..]
        .iter()
        .filter_map(|r| r["input"].as_array())
        .flatten()
        .find(|item| item["type"] == "function_call_output")
        .expect("recall output")["output"]
        .as_str()
        .unwrap()
        .to_owned();
    let payload: Value = serde_json::from_str(&output)?;
    assert_eq!(payload["ok"], true, "{payload}");
    Ok((payload, last_selection_ms(&s.sandbox.data)?))
}

fn last_selection_ms(data: &Path) -> Result<f64, HarnessError> {
    let events = std::fs::read_to_string(data.join("metrics/operational-events.jsonl"))?;
    Ok(events
        .lines()
        .rev()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find(|event| event["name"] == "recall_v2_graph_read_ppr")
        .and_then(|event| event["durationMs"].as_f64())
        .expect("recall selection metric"))
}

/// The coverage-bearing part of a recall output.
pub(super) fn coverage(output: &Value) -> Value {
    json!({
        "status": output["output"]["status"],
        "graph": output["output"]["coverage"]["graph"],
        "source": output["output"]["coverage"]["source"],
    })
}

pub(super) fn pending(output: &Value) -> bool {
    output["output"]["coverage"]["graph"]["codes"]
        .as_array()
        .unwrap()
        .iter()
        .any(|code| code == "ingestion_pending")
}
