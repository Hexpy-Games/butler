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

mod storage_concurrency_support;
use storage_concurrency_support::{seed, verify_rows};
const REQUEST: &str = "Write the numbers from one to twelve as English words, separated by single spaces, and nothing else.";
const SESSIONS: usize = 8;
const DELTAS: usize = 200;

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
fn p95(samples: &mut [u64]) -> u64 {
    samples.sort_unstable();
    samples[(samples.len() * 95).div_ceil(100) - 1]
}

async fn views(
    gw: Gateway,
    database: std::path::PathBuf,
    session: String,
    turn: String,
) -> Result<Vec<u64>, HarnessError> {
    let mut samples = Vec::new();
    let mut prior = String::new();
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        assert!(Instant::now() < deadline, "stream never finished");
        let db_path = database.clone();
        let db_turn = turn.clone();
        let committed = tokio::task::spawn_blocking(move || {
            use rusqlite::{Connection, OptionalExtension};
            let db = Connection::open_with_flags(db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
            db.query_row("SELECT text FROM messages WHERE turn_id=?1 AND role='assistant' ORDER BY rowid DESC LIMIT 1", [&db_turn], |row| row.get::<_, String>(0)).optional().unwrap()
        }).await.unwrap();
        let start = Instant::now();
        let reply = gw
            .get(&format!("/session-view?session_id={session}"))
            .await?;
        let elapsed = u64::try_from(start.elapsed().as_micros()).unwrap();
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
            return Ok(samples);
        }
        samples.push(elapsed);
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn run(baseline: bool) -> Result<(u64, u64, u64, u64), HarnessError> {
    let mut setup = Setup::new(if baseline {
        "STORAGE-BEFORE"
    } else {
        "STORAGE-AFTER"
    })?
    .stub_cassette(cassette()?)
    .env("BUTLER_E2E_STORAGE_METRICS", "1")
    .env("BUTLER_E2E_INGRESS_CAPACITY", "8")
    .env("BUTLER_E2E_STREAM_UNCOALESCED", "1");
    if baseline {
        setup = setup.env("BUTLER_E2E_STORAGE_BASELINE", "1");
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
    let mut samples: Vec<u64> =
        try_join_all(sessions.iter().zip(&turns).map(|(session, turn)| {
            views(s.gw.clone(), path.clone(), session.clone(), turn.clone())
        }))
        .await?
        .into_iter()
        .flatten()
        .collect();
    assert!(samples.len() >= SESSIONS, "did not sample during streaming");
    for (session, turn) in sessions.iter().zip(&turns) {
        let reply =
            s.gw.wait_terminal(session, turn, Duration::from_secs(10))
                .await?;
        assert_eq!(turn_state(&reply), "delivered");
    }
    s.agent.terminate().await?;
    verify_rows(&path, &sessions, &turns, DELTAS, &answer());
    let metrics: Value =
        serde_json::from_slice(&std::fs::read(path.with_extension("metrics.json"))?)?;
    assert_eq!(metrics["busy"], 0, "SQLite BUSY/LOCKED");
    let mut operations = metrics["operation_us"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_u64().unwrap())
        .collect::<Vec<_>>();
    let result = (
        metrics["commits"].as_u64().unwrap(),
        metrics["wal_bytes"].as_u64().unwrap(),
        p95(&mut operations),
        p95(&mut samples),
    );
    s.finish().await?;
    Ok(result)
}

#[tokio::test]
async fn eight_streams_keep_exact_content_with_bounded_persistence_and_reads()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let before = run(true).await?;
    let after = run(false).await?;
    eprintln!(
        "STORAGE N=8 x 200; before commits/turn={} WAL bytes/turn={} persist p95={}us view p95={}us; after commits/turn={} WAL bytes/turn={} persist p95={}us view p95={}us",
        before.0 as f64 / 8.0,
        before.1 / 8,
        before.2,
        before.3,
        after.0 as f64 / 8.0,
        after.1 / 8,
        after.2,
        after.3
    );
    assert!(after.0 < before.0, "commits did not decrease");
    assert!(after.1 < before.1, "WAL did not decrease");
    assert!(after.2 < 10_000, "persist p95 {}us", after.2);
    assert!(after.3 < 20_000, "view p95 {}us", after.3);
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
    let event = |name: &str| json!({"eventId":format!("skills-{name}"),"sessionId":"butler/app-general","kind":"system","timestamp":"2026-09-30T00:00:00Z","payload":{"category":"context.skills.loaded","details":{"turnId":turn,"skillNames":[name,name,"not a token"]}}});
    for name in ["first", "later"] {
        use std::io::Write as _;
        let mut file = std::fs::OpenOptions::new().append(true).open(&path)?;
        writeln!(file, "{}", event(name))?;
        let view = s.gw.get("/session-view?session_id=general").await?;
        assert_eq!(view.status, 200);
        assert_eq!(view.data()["skills_used"], json!([name]));
        assert_eq!(view.data()["messages"].as_array().unwrap().len(), 2);
    }
    // Same-length rewrite must invalidate the index, even with the same inode.
    let rewritten = format!("{original}{}\n{}\n", event("first"), event("other"));
    assert_eq!(std::fs::metadata(&path)?.len(), rewritten.len() as u64);
    std::fs::write(&path, rewritten)?;
    let view = s.gw.get("/session-view?session_id=general").await?;
    assert_eq!(view.data()["skills_used"], json!(["other"]));
    std::fs::write(&path, format!("{}\n", event("short")))?;
    let view = s.gw.get("/session-view?session_id=general").await?;
    assert_eq!(view.data()["skills_used"], json!(["short"]));
    let escaped = event("escaped")
        .to_string()
        .replace("context.skills.loaded", r"context.ski\u006cls.loaded");
    std::fs::write(&path, format!("{escaped}\n"))?;
    let view = s.gw.get("/session-view?session_id=general").await?;
    assert_eq!(view.data()["skills_used"], json!(["escaped"]));
    s.finish().await
}
