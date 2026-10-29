//! Memory-gate holding, mirror state and recall calls for the inventory
//! coverage scenarios.
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
    provider::Pacing,
    scenario::{Scenario, Setup},
};
use butler_platform::sqlite;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
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
    let s = Setup::new(id)?
        .stub_cassette(cassette)
        .env("BUTLER_METRICS_ENABLED", "1")
        .env("BUTLER_MEMORY_SYNC_TRACE", "1")
        .start()
        .await?;
    // Coverage compares recall outputs, not streaming: replay each recorded
    // chunk without its recorded inter-chunk delay (about 0.6 s per turn).
    s.provider()?.set_pacing(Pacing {
        scale: 0.0,
        cap_ms: 0,
        min_ms: 0,
    });
    Ok(s)
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
/// store change and every registered job of `projected` sessions is
/// complete.
pub(super) async fn settle(data: &Path, projected: &[&str]) {
    settle_jobs(data, "IN", projected).await;
}

/// [`settle`] for every registered job except those of `excluded` sessions.
/// The projection serves jobs round-robin, so one job's windows wait behind
/// every other open job: draining a phase's own recall turns keeps the next
/// phase from inheriting them.
pub(super) async fn drain(data: &Path, excluded: &[&str]) {
    settle_jobs(data, "NOT IN", excluded).await;
}

/// Releases `gate` so the consumer applies the held changes, drains (see
/// [`drain`]) and holds the gate again. Nothing is in flight when the gate
/// is taken back, so the hold interrupts no extraction.
pub(super) async fn apply(
    data: &Path,
    gate: sqlite::Connection,
    excluded: &[&str],
) -> sqlite::Connection {
    release_gate(&gate);
    drop(gate);
    drain(data, excluded).await;
    hold_gate(data)
}

async fn settle_jobs(data: &Path, membership: &str, sessions: &[&str]) {
    let marks = vec!["?"; sessions.len()].join(",");
    let incomplete = format!(
        "SELECT COUNT(*) FROM memory_projection_jobs j JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id \
         WHERE c.conversation_session_id {membership} ({marks}) AND json_extract(j.semantic_graph_state,'$.state')!='complete'"
    );
    tokio::time::timeout(Duration::from_secs(180), async {
        loop {
            let graph_path = graph_path(data).unwrap();
            let ready = mirror_current(data)
                && super::super::memory_idle::catchup_checkpoint_current(data, &graph_path)
                && state(&graph(data), "canonical_catchup_change_seq").as_deref()
                    == Some(canonical_position(data).1.to_string().as_str())
                && graph(data)
                    .query_row(&incomplete, rusqlite::params_from_iter(sessions), |row| {
                        row.get::<_, i64>(0)
                    })
                    .unwrap()
                    == 0;
            if ready {
                return;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("inventory mirror and projection did not settle");
}

/// Waits until the inventory mirror reflects every committed store change.
pub(super) async fn mirror_settled(data: &Path) {
    tokio::time::timeout(Duration::from_secs(180), async {
        while !mirror_current(data) {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("inventory mirror did not settle");
}

/// Jobs that never completed, with their windows' and last attempts'
/// state, for the scenario log.
pub(super) fn incomplete_jobs(data: &Path) -> Vec<String> {
    let db = graph(data);
    let mut statement = db
        .prepare(
            "SELECT c.source_key||' semantic='||COALESCE(json_extract(j.semantic_graph_state,'$.state'),'?')||' windows='||\
             COALESCE((SELECT group_concat(w.state||'/'||COALESCE(w.error_code,'-')||'/'||w.attempt_count) FROM memory_projection_windows w WHERE w.job_id=j.job_id),'')\
             FROM memory_projection_jobs j JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id \
             WHERE json_extract(j.semantic_graph_state,'$.state')!='complete'",
        )
        .unwrap();
    statement
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .map(Result::unwrap)
        .collect()
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
    let start = s.provider()?.request_count();
    let started = std::time::Instant::now();
    let (_, turn) = s.turn(chat_id, variant.prompt).await?;
    eprintln!(
        "MEM-COVERAGE recall_turn_ms={}",
        started.elapsed().as_millis()
    );
    assert_eq!(turn["state"], "delivered", "{turn}");
    let requests = s.provider()?.requests_since(start);
    let output = requests
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

/// Recalls every variant (each from its own chat) through the mirror and
/// through a full scan of the same unchanged stores; returns whether each
/// reported pending ingestion.
pub(super) async fn compare(
    s: &Scenario,
    variants: &[Variant],
    chats: &[String],
    step: &str,
) -> Result<Vec<bool>, HarnessError> {
    let data = &s.sandbox.data;
    let mut pending_by_variant = Vec::new();
    for (variant, chat) in variants.iter().zip(chats) {
        let (incremental, _) = recall_in(s, chat, variant).await?;
        let phase = hide_mirror(data);
        let (full, _) = recall_in(s, chat, variant).await?;
        show_mirror(data, &phase);
        assert_eq!(
            coverage(&incremental),
            coverage(&full),
            "{step}: {} mirror coverage differs from the full scan",
            variant.prompt
        );
        pending_by_variant.push(pending(&incremental));
    }
    eprintln!("MEM-COVERAGE {step} pending={pending_by_variant:?}");
    Ok(pending_by_variant)
}

/// One chat per variant: each chat admits a bounded message rate.
pub(super) async fn chats(s: &Scenario, count: usize) -> Result<Vec<String>, HarnessError> {
    let mut chats = Vec::new();
    for index in 0..count {
        chats.push(chat(s, &format!("Coverage recall {index}")).await?);
    }
    Ok(chats)
}
