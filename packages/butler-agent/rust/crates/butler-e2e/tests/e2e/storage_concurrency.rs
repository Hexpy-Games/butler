//! CQRS and streaming persistence through the real HTTP/runtime projection path.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use butler_e2e::e2e::{
    HarnessError,
    cassette::{Cassette, Chunk},
    gateway::{Gateway, turn_state},
    scenario::{Setup, accepted_turn_id},
};
use futures_util::future::try_join_all;
use serde_json::{Value, json};
use std::time::{Duration, Instant};

use super::storage_concurrency_support;
use storage_concurrency_support::{p95, seed, verify_rows};
const REQUEST: &str = "Write the numbers from one to twelve as English words, separated by single spaces, and nothing else.";
const SESSIONS: usize = 8;
const DELTAS: usize = 200;
// Keeps a fixed margin over local batching while staying below one commit per delta.
const MAX_COMMITS_PER_TURN: u64 = 100;
const MAX_WAL_BYTES_PER_TURN: u64 = 16 * 1024 * 1024;

struct ScenarioMetrics {
    commits: u64,
    wal_bytes: u64,
    persist_p95_us: Option<u64>,
    view_p95_us: Option<u64>,
}

fn answer() -> String {
    use std::fmt::Write as _;
    let mut text = String::new();
    for i in 0..DELTAS {
        write!(&mut text, "delta-{i:03} ").unwrap();
    }
    text.trim_end().to_owned()
}

fn cassette() -> Result<Cassette, HarnessError> {
    let mut cassette = Cassette::load("TURN-01")?;
    let response = &mut cassette.exchanges[0].response;
    let mut chunks = Vec::new();
    let mut inserted = false;
    for chunk in &response.chunks {
        for data in chunk
            .text
            .lines()
            .filter_map(|line| line.strip_prefix("data: "))
        {
            let mut event: Value = serde_json::from_str(data)?;
            if event["type"] == "response.output_text.delta" {
                if !inserted {
                    for i in 0..DELTAS {
                        let mut delta = event.clone();
                        delta["delta"] = if i + 1 == DELTAS {
                            format!("delta-{i:03}")
                        } else {
                            format!("delta-{i:03} ")
                        }
                        .into();
                        chunks.push(Chunk {
                            delay_ms: 5,
                            text: format!("data: {delta}\n\n"),
                        });
                    }
                    inserted = true;
                }
                continue;
            }
            rewrite_text(&mut event);
            chunks.push(Chunk {
                delay_ms: 0,
                text: format!("data: {event}\n\n"),
            });
        }
    }
    assert!(inserted);
    response.chunks = chunks;
    Ok(cassette)
}
fn rewrite_text(value: &mut Value) {
    match value {
        Value::Object(map) => {
            if map.contains_key("text")
                && map
                    .get("text")
                    .and_then(Value::as_str)
                    .is_some_and(|s| !s.is_empty())
            {
                map.insert("text".into(), answer().into());
            }
            for value in map.values_mut() {
                rewrite_text(value);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(rewrite_text),
        _ => {}
    }
}

async fn views(
    gw: Gateway,
    database: std::path::PathBuf,
    session: String,
    turn: String,
    measure_latency: bool,
) -> Result<Vec<u64>, HarnessError> {
    let mut samples = Vec::new();
    let mut phases = storage_concurrency_support::HttpPhases::default();
    let mut prior = String::new();
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        assert!(Instant::now() < deadline, "stream never finished");
        let db_path = database.clone();
        let db_turn = turn.clone();
        let committed = tokio::task::spawn_blocking(move || {
            use rusqlite::{Connection, OptionalExtension};
            if !measure_latency {
                // Readers must not keep the native projection watcher busy
                // ahead of a final receipt. Preserve the original deadline.
                let data = db_path.parent().unwrap().parent().unwrap();
                let db = Connection::open_with_flags(&db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
                let chat: String = db.query_row("SELECT chat_id FROM turns WHERE id=?1", [&db_turn], |row| row.get(0)).unwrap();
                let transcript = data.join(format!("transcripts/butler_app-{chat}.jsonl"));
                if transcript.exists() { assert_ne!(std::fs::read(transcript).unwrap(), [] as [u8; 0]); }
            }
            let db = Connection::open_with_flags(db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
            db.query_row("SELECT text FROM messages WHERE turn_id=?1 AND role='assistant' ORDER BY rowid DESC LIMIT 1", [&db_turn], |row| row.get::<_, String>(0)).optional().unwrap()
        }).await.unwrap();
        let start = measure_latency.then(storage_concurrency_support::start_request);
        let reply = gw
            .get(&format!("/session-view?session_id={session}"))
            .await?;
        if let Some(start) = start {
            samples.push(phases.observe_reply(&reply, start, samples.len()));
        }
        assert_eq!(reply.status, 200, "{}", reply.text);
        let view = reply.data();
        assert_eq!(view["session_id"], session);
        assert_eq!(view["message_window"]["complete"], true);
        let messages = view["messages"].as_array().unwrap();
        assert!(messages.len() <= 2);
        if committed.is_some() {
            assert_eq!(messages.len(), 2, "omitted committed message");
        }
        assert_eq!(messages[0]["text"], REQUEST);
        assert!(
            messages
                .windows(2)
                .all(|pair| pair[0]["cursor"].as_u64() < pair[1]["cursor"].as_u64())
        );
        if let Some(message) = messages.iter().find(|m| m["role"] == "assistant") {
            let text = message["text"].as_str().unwrap();
            assert!(
                answer().starts_with(text),
                "out-of-order or missing delta: {text}"
            );
            assert!(text.starts_with(&prior), "stale view");
            if let Some(committed) = &committed {
                assert!(
                    text.starts_with(committed),
                    "view older than the committed App state"
                );
            }
            prior = text.to_owned();
        }
        if view["latest_turn"]["id"] == turn && view["latest_turn"]["state"] == "delivered" {
            assert_eq!(messages.len(), 2);
            assert_eq!(prior, answer());
            if measure_latency {
                phases.report();
            }
            return Ok(samples);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn storage_metrics(
    path: &std::path::Path,
    measure_latency: bool,
    mut view_samples: Vec<u64>,
) -> Result<ScenarioMetrics, HarnessError> {
    let metrics: Value =
        serde_json::from_slice(&std::fs::read(path.with_extension("metrics.json"))?)?;
    assert_eq!(metrics["busy"], 0, "SQLite BUSY/LOCKED");
    let (persist_p95_us, view_p95_us) = if measure_latency {
        storage_concurrency_support::report_slow_views(&metrics);
        assert!(
            view_samples.len() >= SESSIONS,
            "did not sample during streaming"
        );
        for (kind, field) in [("VIEW", "view_phase_us"), ("WRITE", "write_phase_us")] {
            if let Some(phases) = metrics[field].as_object() {
                for (phase, values) in phases {
                    let mut samples = values
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|v| v.as_u64().unwrap())
                        .collect::<Vec<_>>();
                    eprintln!(
                        "STORAGE {kind} phase={phase} count={} p95_us={}",
                        samples.len(),
                        p95(&mut samples)
                    );
                }
            }
        }
        let mut operations = metrics["operation_us"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_u64().unwrap())
            .collect::<Vec<_>>();
        (Some(p95(&mut operations)), Some(p95(&mut view_samples)))
    } else {
        (None, None)
    };
    Ok(ScenarioMetrics {
        commits: metrics["commits"].as_u64().unwrap(),
        wal_bytes: metrics["wal_bytes"].as_u64().unwrap(),
        persist_p95_us,
        view_p95_us,
    })
}

async fn run(baseline: bool, measure_latency: bool) -> Result<ScenarioMetrics, HarnessError> {
    let mut setup = Setup::new(if baseline {
        "STORAGE-BEFORE"
    } else {
        "STORAGE-AFTER"
    })?
    .stub_cassette(cassette()?)
    .env("BUTLER_E2E_INGRESS_CAPACITY", "8")
    .env("BUTLER_E2E_STREAM_UNCOALESCED", "1");
    setup = storage_concurrency_support::instrument(setup);
    if baseline {
        setup = setup.env("BUTLER_E2E_STORAGE_BASELINE", "1");
    }
    if baseline && let Some(binary) = std::env::var_os("BUTLER_E2E_STORAGE_MAIN_BIN") {
        butler_e2e::e2e::executable::copy(std::path::Path::new(&binary), &setup.sandbox.binary)?;
    }
    let mut s = setup.start().await?;
    s.agent.terminate().await?;
    let path = s.sandbox.data.join("app-server/butler-client.sqlite");
    let seed_path = path.clone();
    tokio::task::spawn_blocking(move || seed(&seed_path))
        .await
        .unwrap();
    s.gw = s.agent.start_again().await?;
    let mut sessions = Vec::new();
    for i in 0..SESSIONS {
        let created =
            s.gw.post(
                "/sessions",
                json!({"kind":"chat","title":format!("stream-{i}")}),
            )
            .await?;
        assert_eq!(created.status, 201, "{}", created.text);
        sessions.push(created.data()["session"]["id"].as_str().unwrap().to_owned());
    }
    let turns = try_join_all(
        sessions
            .iter()
            .map(|session| async { accepted_turn_id(&s.gw.say(session, REQUEST).await?) }),
    )
    .await?;
    let view_samples: Vec<u64> =
        try_join_all(sessions.iter().zip(&turns).map(|(session, turn)| {
            views(
                s.gw.clone(),
                path.clone(),
                session.clone(),
                turn.clone(),
                measure_latency,
            )
        }))
        .await?
        .into_iter()
        .flatten()
        .collect();
    for (session, turn) in sessions.iter().zip(&turns) {
        let reply =
            s.gw.wait_terminal(session, turn, Duration::from_secs(10))
                .await?;
        assert_eq!(turn_state(&reply), "delivered");
    }
    s.agent.terminate().await?;
    verify_rows(&path, &sessions, &turns, DELTAS, REQUEST, &answer());
    storage_concurrency_support::report_history_load(&s.sandbox.logs)?;
    let result = storage_metrics(&path, measure_latency, view_samples)?;
    s.finish().await?;
    Ok(result)
}

#[tokio::test]
async fn eight_streams_keep_exact_content_and_bounded_storage_work() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let before = run(true, false).await?;
    let after = run(false, false).await?;
    eprintln!(
        "STORAGE N=8 x 200; before commits/turn={:.1} WAL bytes/turn={}; after commits/turn={:.1} WAL bytes/turn={}",
        before.commits as f64 / SESSIONS as f64,
        before.wal_bytes / u64::try_from(SESSIONS).unwrap(),
        after.commits as f64 / SESSIONS as f64,
        after.wal_bytes / u64::try_from(SESSIONS).unwrap()
    );
    assert_storage_work(&before, &after);
    Ok(())
}

fn assert_storage_work(before: &ScenarioMetrics, after: &ScenarioMetrics) {
    let sessions = u64::try_from(SESSIONS).unwrap();
    assert!(after.commits < before.commits, "commits did not decrease");
    assert!(
        after.commits.div_ceil(sessions) <= MAX_COMMITS_PER_TURN,
        "commits per turn exceeded {MAX_COMMITS_PER_TURN}"
    );
    assert!(after.wal_bytes < before.wal_bytes, "WAL did not decrease");
    assert!(
        after.wal_bytes.div_ceil(sessions) <= MAX_WAL_BYTES_PER_TURN,
        "WAL bytes per turn exceeded {MAX_WAL_BYTES_PER_TURN}"
    );
}

#[tokio::test]
async fn perf_storage_concurrency_eight_streams_keep_exact_content_with_bounded_persistence_and_reads()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let before = run(true, true).await?;
    let metrics = run(false, true).await?;
    assert_storage_work(&before, &metrics);
    eprintln!(
        "STORAGE PERF before commits/turn={:.1} WAL bytes/turn={} session-view p95={}us; after commits/turn={:.1} WAL bytes/turn={}",
        before.commits as f64 / SESSIONS as f64,
        before.wal_bytes / SESSIONS as u64,
        before.view_p95_us.unwrap(),
        metrics.commits as f64 / SESSIONS as f64,
        metrics.wal_bytes / SESSIONS as u64,
    );
    let persist_p95_us = metrics.persist_p95_us.unwrap();
    let view_p95_us = metrics.view_p95_us.unwrap();
    eprintln!(
        "STORAGE PERF N=8 x 200; persist p95={persist_p95_us}us; session-view p95={view_p95_us}us"
    );
    butler_e2e::assert_wall_clock_budget!(
        Duration::from_micros(persist_p95_us),
        Duration::from_millis(10),
        "storage persist p95"
    );
    butler_e2e::assert_wall_clock_budget!(
        Duration::from_micros(view_p95_us),
        Duration::from_millis(20),
        "storage session-view p95"
    );
    Ok(())
}

#[tokio::test]
async fn final_stream_boundary_survives_an_immediate_crash() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("STORAGE-BOUNDARY")?
        .stub_cassette(cassette()?)
        .env("BUTLER_E2E_STREAM_UNCOALESCED", "1")
        .start()
        .await?;
    let accepted = s.gw.say("general", REQUEST).await?;
    let turn = accepted_turn_id(&accepted)?;
    let delivered =
        s.gw.wait_terminal("general", &turn, Duration::from_secs(60))
            .await?;
    assert_eq!(turn_state(&delivered), "delivered");
    s.agent.kill9()?;
    let path = s.sandbox.data.join("app-server/butler-client.sqlite");
    verify_rows(
        &path,
        &["general".into()],
        std::slice::from_ref(&turn),
        DELTAS,
        REQUEST,
        &answer(),
    );
    s.gw = s.agent.start_again().await?;
    let view = s.gw.get("/session-view?session_id=general").await?;
    assert_eq!(view.status, 200);
    assert_eq!(view.data()["messages"][1]["text"], answer());
    assert_eq!(view.data()["latest_turn"]["state"], "delivered");
    s.finish().await
}

#[tokio::test]
async fn idle_delta_window_flushes_without_a_later_boundary() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    use butler_e2e::e2e::faults::{Fault, Transform};
    use rusqlite::{Connection, OptionalExtension};
    let mut s = Setup::new("STORAGE-IDLE-WINDOW")?
        .env("BUTLER_E2E_STORAGE_METRICS", "1")
        .stub_cassette(cassette()?)
        .env("BUTLER_E2E_STREAM_UNCOALESCED", "1")
        .start()
        .await?;
    // Four stream headers plus five deltas, then no completion or tool boundary.
    s.provider()?
        .inject(Fault::first_call(REQUEST, Transform::StallAfter(9)))?;
    let turn = accepted_turn_id(&s.gw.say("general", REQUEST).await?)?;
    let expected = "delta-000 delta-001 delta-002 delta-003 delta-004 ";
    let path = s.sandbox.data.join("app-server/butler-client.sqlite");
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let db_path = path.clone();
        let db_turn = turn.clone();
        let text = tokio::task::spawn_blocking(move || {
            let db =
                Connection::open_with_flags(db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                    .unwrap();
            db.query_row(
                "SELECT text FROM messages WHERE turn_id=?1 AND role='assistant'",
                [&db_turn],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .unwrap()
        })
        .await
        .unwrap();
        if text.as_deref() == Some(expected) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "idle stream was not committed: {text:?}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    s.agent.kill9()?;
    let saved = tokio::task::spawn_blocking(move || {
        let db = Connection::open(path).unwrap();
        db.query_row(
            "SELECT text,status FROM messages WHERE turn_id=?1 AND role='assistant'",
            [&turn],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .unwrap()
    })
    .await
    .unwrap();
    assert_eq!(saved, (expected.to_owned(), "streaming".into()));
    s.finish().await
}

#[tokio::test]
async fn skill_read_index_keeps_latest_appends_and_replaced_content() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("STORAGE-SKILL-READ")?
        .cassette("TURN-01")
        .start()
        .await?;
    let turn = accepted_turn_id(&s.gw.say("general", REQUEST).await?)?;
    s.gw.wait_terminal("general", &turn, Duration::from_secs(60))
        .await?;
    let path = s.sandbox.data.join("transcripts/butler_app-general.jsonl");
    let original = std::fs::read_to_string(&path)?;
    let event = |name: &str| json!({"eventId":format!("skills-{name}"),"sessionId":"butler/app-general","kind":"system","timestamp":"2026-09-30T00:00:00Z","payload":{"category":"context.skills.loaded","details":{"turnId":turn,"skillNames":[format!(" {name} "),name,"not a token"]}}});
    for name in ["first", "later"] {
        use std::io::Write as _;
        let mut file = std::fs::OpenOptions::new().append(true).open(&path)?;
        writeln!(file, "{}", event(name))?;
        let view = storage_concurrency_support::verify_skill_views(&s, &json!([name])).await?;
        assert_eq!(view.data()["messages"].as_array().unwrap().len(), 2);
    }
    // Same-length rewrite must invalidate the index, even with the same inode.
    let rewritten = format!("{original}{}\n{}\n", event("first"), event("other"));
    assert_eq!(std::fs::metadata(&path)?.len(), rewritten.len() as u64);
    std::fs::write(&path, rewritten)?;
    storage_concurrency_support::verify_skill_views(&s, &json!(["other"])).await?;
    std::fs::write(&path, format!("{}\n", event("short")))?;
    storage_concurrency_support::verify_skill_views(&s, &json!(["short"])).await?;
    let escaped = event("escaped")
        .to_string()
        .replace("context.skills.loaded", r"context.ski\u006cls.loaded");
    std::fs::write(&path, format!("{escaped}\n"))?;
    storage_concurrency_support::verify_skill_views(&s, &json!(["escaped"])).await?;
    storage_concurrency_support::verify_skill_record_boundaries(&s, &path, &event("boundary"))
        .await?;
    s.finish().await
}
