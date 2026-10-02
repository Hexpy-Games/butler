//! Alias index retirement runs off readiness, resumes, and leaves no idle writes.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
#[path = "support/alias_index_audit.rs"]
mod alias_index_audit;
#[path = "support/memory_fixture.rs"]
mod memory_fixture;
use butler_e2e::e2e::{
    HarnessError,
    cassette::{Cassette, Chunk},
    gateway::{TERMINAL, turn_state},
    provider::Pacing,
    scenario::{Fixture, Scenario, Setup, accepted_turn_id},
};
use rusqlite::{Connection, OpenFlags};
use serde_json::json;
use std::{
    path::Path,
    time::{Duration, Instant},
};

fn obsolete(db: &Connection) -> i64 {
    db.query_row("SELECT COUNT(*) FROM sqlite_schema WHERE name IN ('idx_alias_postings_entity','idx_alias_postings_scope_gram_node')", [], |r| r.get(0)).unwrap()
}
fn seed(path: &Path) -> Connection {
    let db = Connection::open(path).unwrap();
    db.execute_batch("CREATE INDEX idx_alias_postings_entity ON memory_alias_postings(node_id,gram,source_id,surface_original);
        CREATE INDEX idx_alias_postings_scope_gram_node ON memory_alias_postings(identity_scope,project_id,gram,node_id);
        INSERT INTO memory_nodes(id,type,label_original,identity_scope,created_at) VALUES('synthetic','entity','surface','user','2026-01-01');
        INSERT INTO memory_chunks(memory_chunk_id,source_key,current_revision,origin_kind,status,source_hash,created_at,updated_at) VALUES('chunk','chunk','1','user_input','active','hash','2026-01-01','2026-01-01');
        INSERT INTO memory_chunk_sources(source_id,episode_id,revision,source_kind,part_id,scalar_pointer,byte_start,byte_end,content_hash,role,origin_kind,observed_at,basis) VALUES('source','chunk','1','conversation','part','',0,7,'hash','user','user_input','2026-01-01','user_statement');
        INSERT INTO memory_alias_postings VALUES('ab','synthetic','source','surface','user',NULL);").unwrap();
    db
}
fn version(db: &Connection) -> i64 {
    db.pragma_query_value(None, "data_version", |r| r.get(0))
        .unwrap()
}
async fn until_count(path: &Path, expected: i64) {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        if obsolete(&db) == expected {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "background indexes did not retire"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn background_drop_resumes_after_interruption_and_stays_idle() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("ALIAS-DROP-RESUME")?.fixture(Fixture::Empty);
    let graph = memory_fixture::initialize_empty(&setup.sandbox.data)?;
    let db = seed(&graph);
    // An unrelated SQLite writer prevents DROP, but cannot prevent readiness.
    db.execute_batch("BEGIN IMMEDIATE").unwrap();
    let started = Instant::now();
    let mut s = setup.start().await?;
    assert_eq!(obsolete(&db), 2);
    tokio::time::sleep(Duration::from_secs(2)).await;
    s.agent.kill9()?;
    db.execute_batch("ROLLBACK").unwrap();
    assert_eq!(obsolete(&db), 2, "blocked drop partially committed");
    s.gw = s.agent.start_again().await?;
    until_count(&graph, 1).await;
    s.agent.kill9()?;
    assert_eq!(obsolete(&db), 1, "both indexes retired under one lease");
    s.gw = s.agent.start_again().await?;
    until_count(&graph, 0).await;
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM memory_alias_postings", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    // Allow unrelated first-sweep recovery/cache stages to settle.
    tokio::time::sleep(Duration::from_secs(10)).await;
    let lock = s
        .sandbox
        .data
        .join("cognition/consolidation/locks/consolidation.lock.coord.sqlite");
    let gate = Connection::open_with_flags(lock, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let before = (version(&db), version(&gate));
    tokio::time::sleep(Duration::from_secs(60)).await;
    let commits = version(&db) - before.0;
    let leases = version(&gate) - before.1;
    assert_eq!(
        (commits, leases),
        (0, 0),
        "idle commits/leases after completion"
    );
    s.restart().await?;
    assert_eq!(obsolete(&db), 0, "startup recreated indexes");
    eprintln!(
        "ALIAS-DROP elapsed_ms={} idle_graph_commits={commits} idle_leases={leases}",
        started.elapsed().as_millis()
    );
    s.finish().await
}

#[tokio::test]
async fn shutdown_with_drop_queued_meets_deadline() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (setup, prompt) = shutdown_setup()?;
    let graph = memory_fixture::initialize_empty(&setup.sandbox.data)?;
    let db = seed(&graph);
    db.execute_batch("BEGIN IMMEDIATE").unwrap();
    let mut s = setup.start().await?;
    let running = queue_followup(&s, &prompt).await?;
    tokio::time::sleep(Duration::from_secs(2)).await;
    let started = Instant::now();
    s.agent.terminate().await?;
    let elapsed = started.elapsed();
    butler_e2e::assert_wall_clock_budget!(
        elapsed,
        Duration::from_secs(5),
        "queued DROP shutdown before forced exit"
    );
    assert_eq!(obsolete(&db), 2);
    db.execute_batch("ROLLBACK").unwrap();
    s.gw = s.agent.start_again().await?;
    until_count(&graph, 0).await;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let turns = s.gw.turns("general").await?;
        if turns.len() == 2 && turns.iter().any(|turn| turn_state(turn) == "delivered") {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "queued follow-up did not resume: {turns:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let interrupted = s.gw.turn("general", &running).await?.unwrap();
    assert_eq!(interrupted["safe_error_code"], "turn_interrupted");
    let messages = s.gw.messages("general").await?;
    assert_eq!(
        messages
            .iter()
            .filter(|message| message["role"] == "user")
            .count(),
        2
    );
    assert_eq!(
        messages
            .iter()
            .filter(|message| message["role"] == "assistant"
                && message["text"]
                    .as_str()
                    .is_some_and(|text| text.trim() == "waiting"))
            .count(),
        1
    );
    assert_eq!(s.provider()?.served(), 2);
    eprintln!("ALIAS-DROP-SHUTDOWN shutdown_ms={}", elapsed.as_millis());
    s.finish().await
}

fn shutdown_setup() -> Result<(Setup, String), HarnessError> {
    let mut cassette = Cassette::load("Q-02")?;
    let prompt = cassette.exchanges[0].request.key.user_request.clone();
    cassette.exchanges[0].response.chunks = cassette.exchanges[0]
        .response
        .body()
        .split("\n\n")
        .filter(|text| !text.is_empty())
        .enumerate()
        .map(|(index, text)| Chunk {
            delay_ms: if index < 5 { 0 } else { 30_000 },
            text: format!("{text}\n\n"),
        })
        .collect();
    Ok((
        Setup::new("ALIAS-DROP-SHUTDOWN")?.stub_cassette(cassette),
        prompt,
    ))
}

async fn queue_followup(s: &Scenario, prompt: &str) -> Result<String, HarnessError> {
    s.provider()?.set_pacing(Pacing {
        scale: 1.0,
        cap_ms: 30_000,
        min_ms: 0,
    });
    let running = accepted_turn_id(&s.gw.say("general", prompt).await?)?;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if s.gw.messages("general").await?.iter().any(|message| {
            message["turn_id"] == running
                && message["role"] == "assistant"
                && message["text"]
                    .as_str()
                    .is_some_and(|text| text.starts_with("one"))
        }) {
            break;
        }
        assert!(Instant::now() < deadline, "stream never became active");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let queued = s.gw.post("/session-queue", json!({"chat_id":"general", "text":"Reply with exactly the word: waiting", "client_message_id":uuid::Uuid::new_v4().to_string()})).await?;
    assert_eq!(queued.status, 202, "{}", queued.text);
    assert!(!TERMINAL.contains(&turn_state(&s.gw.turn("general", &running).await?.unwrap())));
    Ok(running)
}

#[test]
fn owner_scale_posting_queries_keep_plans_and_results() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("ALIAS-DROP-AUDIT")?;
    let directory = setup.sandbox.data.join("audit");
    let script =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/alias-index-drop-benchmark.py");
    let output = std::process::Command::new("python3")
        .arg(script)
        .arg(format!("--prepare={}", directory.display()))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    alias_index_audit::run(&directory);
    Ok(())
}
