//! An abandoned extraction retains its source coverage until it is applied once.
use super::{fts, memory_stubs};
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    fixtures,
    scenario::{Fixture, Scenario, Setup},
};
use butler_platform::sqlite;
use serde_json::json;
use std::{
    io::{BufRead, BufReader, Write},
    net::{TcpListener, TcpStream},
    path::Path,
    time::{Duration, Instant},
};

#[tokio::test]
async fn mem_projection_lock_retry() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    recover(false, false, false).await
}

#[tokio::test]
async fn mem_projection_unknown_restart() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    recover(true, false, false).await
}

#[tokio::test]
async fn mem_projection_stranded_unknown_restart() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    recover(true, true, false).await
}

#[tokio::test]
async fn mem_projection_contention_settles_before_retry() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    recover(false, false, true).await
}

#[tokio::test]
async fn mem_projection_repeated_dead_owner_exhausts_cap() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, remember, address, observer) = start().await?;
    s.select_model(&s.model).await?;
    s.provider()?.set_memory_responder(meaning);
    let gate = s.provider()?.hold_next_reply("\"speaker\":\"user\"");
    s.turn("general", &remember).await?;
    until(|| user_calls(&s) == 1).await;
    let graph = memory_stubs::graph_path(&s.sandbox.data)?;
    let window: String = sqlite::open(&graph)?.query_row(
        "SELECT window_ref FROM memory_projection_windows WHERE state='running' LIMIT 1",
        [],
        |r| r.get(0),
    )?;
    let lock = sqlite::open(
        s.sandbox
            .data
            .join("cognition/consolidation/locks/consolidation.lock.coord.sqlite"),
    )?;
    lock.execute_batch("BEGIN EXCLUSIVE")?;
    gate.release();
    for attempt in 1..=3 {
        // Each model response has returned, but its durable result cannot be saved.
        let ack = expired_wait(&observer).await?;
        s.agent.kill9()?;
        drop(ack);
        lock.execute_batch("ROLLBACK")?;
        s.gw = s.agent.start_again().await?;
        wake_source(&s.sandbox.data)?;
        until(|| window_count(&graph, &window, "state IN ('pending','failed')") == 1).await;
        assert_eq!(
            window_count(
                &graph,
                &window,
                if attempt == 3 {
                    "state='failed' AND error_code='memory_projection_attempts_exhausted' AND next_attempt_at IS NULL"
                } else {
                    "state='pending' AND next_attempt_at IS NOT NULL"
                }
            ),
            1
        );
        assert_eq!(user_calls(&s), attempt);
        if attempt < 3 {
            let gate = s.provider()?.hold_next_reply("\"speaker\":\"user\"");
            jump_to(
                address.clone(),
                format!("2026-10-02T04:{:02}:00.000Z", 1 + attempt * 3),
            )
            .await?;
            wake_source(&s.sandbox.data)?;
            until(|| user_calls(&s) == attempt + 1).await;
            // Acquire the external lock before allowing the returned response to save.
            lock.execute_batch("BEGIN EXCLUSIVE")?;
            gate.release();
        }
    }
    assert_eq!(charged_attempts(&graph, &window)?, 3);
    assert_eq!(window_count(&graph, &window, "output_json IS NULL"), 1);
    let commits: i64 = sqlite::open(&graph)?.query_row(
        "SELECT COUNT(*) FROM memory_meaning_commits WHERE window_ref=?1",
        [&window],
        |r| r.get(0),
    )?;
    assert_eq!(commits, 0);
    jump_to(address, "2026-10-02T04:15:00.000Z".into()).await?;
    wake_source(&s.sandbox.data)?;
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(
        user_calls(&s),
        3,
        "terminal windows must not call the provider again"
    );
    eprintln!("MEM-PROJECTION-DEAD-OWNER calls=3 charged=3 terminal=true commits=0");
    s.finish().await
}

async fn start() -> Result<(Scenario, String, String, tokio::net::TcpListener), HarnessError> {
    let mut cassette = Cassette::load("MEM-01")?;
    let remember = cassette.exchanges[0]
        .request
        .key
        .user_request
        .replace("{{NONCE}}", "amber");
    cassette.exchanges[0].response = cassette.exchanges[1].response.clone();
    let mut call = cassette.exchanges[0].clone();
    call.request.key.user_request = fts::ASK.into();
    call.response = super::memory_response(
        &json!({"type":"function_call","id":"fc_retry","call_id":"call_retry","name":"recall_memory","status":"completed","arguments":json!({"cue":"amber","session_ids":["{{SOURCE_SESSION}}"],"include_vector":false}).to_string()}),
    );
    let mut answer = cassette.exchanges[1].clone();
    answer.request.key.user_request = fts::ASK.into();
    cassette.exchanges.extend([call, answer]);
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let address = listener.local_addr()?.to_string();
    drop(listener);
    let observer = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let setup = Setup::new("MEM-PROJECTION-RETRY")?
        .fixture(Fixture::Empty)
        .stub_cassette(cassette)
        .placeholder("NONCE", "amber")
        .env(
            "BUTLER_E2E_WRITE_WAIT_OBSERVER",
            observer.local_addr()?.to_string(),
        )
        .env("BUTLER_E2E_APP_NOW", "2026-10-02T04:01:00.000Z")
        .env("BUTLER_E2E_MEMORY_WRITE_WAIT_MS", "100")
        .env("BUTLER_E2E_APP_CLOCK_ADDRESS", &address)
        .env(
            "BUTLER_E2E_EMBED_MANIFEST",
            "http://127.0.0.1:1/unavailable",
        );
    fixtures::onboarding_complete(&setup.sandbox.data)?;
    fixtures::scheduler_ran_today(&setup.sandbox.data, "2026-10-02T04:01:00.000Z")?;
    Ok((setup.start().await?, remember, address, observer))
}

async fn until(mut ready: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(90), async {
        while !ready() {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("projection did not recover");
}

async fn recover(restart: bool, stranded: bool, settle: bool) -> Result<(), HarnessError> {
    let (mut s, remember, address, observer) = start().await?;
    s.select_model(&s.model).await?;
    s.provider()?.set_memory_responder(meaning);
    let gate = s.provider()?.hold_next_reply("\"speaker\":\"user\"");
    let (_, turn) = s.turn("general", &remember).await?;
    assert_eq!(turn["state"], "delivered");
    until(|| !s.provider().unwrap().memory_requests().is_empty()).await;
    let graph = memory_stubs::graph_path(&s.sandbox.data)?;
    let db = sqlite::open(&graph)?;
    let (window, session): (String, String) = db.query_row(
        "SELECT w.window_ref,c.conversation_session_id FROM memory_projection_windows w JOIN memory_projection_jobs j USING(job_id) JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id WHERE w.state='running' LIMIT 1", [], |r| Ok((r.get(0)?,r.get(1)?)))?;
    drop(db);
    let lock = sqlite::open(
        s.sandbox
            .data
            .join("cognition/consolidation/locks/consolidation.lock.coord.sqlite"),
    )?;
    lock.execute_batch("BEGIN EXCLUSIVE")?;
    let started = Instant::now();
    if restart {
        s.agent.kill9()?;
        gate.release();
        seed_contention_history(&graph, &window, stranded)?;
    } else {
        gate.release();
        // The observation follows a real expired result-write wait, not elapsed
        // harness time. Its ack holds the owner until the external lock is ready.
        let mut ack = expired_wait(&observer).await?;
        assert_eq!(window_count(&graph, &window, "state='running'"), 1);
        assert_eq!(window_count(&graph, &window, "output_json IS NULL"), 1);
        if settle {
            seed_contention_history(&graph, &window, false)?;
            lock.execute_batch("ROLLBACK")?;
        }
        acknowledge(&mut ack).await?;
        if !settle {
            let mut settlement = expired_wait(&observer).await?;
            lock.execute_batch("ROLLBACK")?;
            acknowledge(&mut settlement).await?;
        }
    }
    if restart {
        lock.execute_batch("ROLLBACK")?;
    }
    drop(lock);
    if restart {
        s.gw = s.agent.start_again().await?;
    }
    wake_source(&s.sandbox.data)?;
    let deferred = if stranded {
        "state='pending'"
    } else {
        "state IN ('pending','failed')"
    };
    until(|| window_count(&graph, &window, deferred) == 1).await;
    assert_eq!(
        window_count(
            &graph,
            &window,
            "state='pending' AND next_attempt_at > '2026-10-02T04:01:00.000Z'"
        ),
        1,
        "an abandoned result must be deferred, not terminal"
    );
    let deadline: String = sqlite::open(&graph)?.query_row(
        "SELECT next_attempt_at FROM memory_projection_windows WHERE window_ref=?1",
        [&window],
        |row| row.get(0),
    )?;
    assert_eq!(
        deadline,
        if (restart && !stranded) || settle {
            "2026-10-02T04:03:00.000Z"
        } else {
            "2026-10-02T04:01:30.000Z"
        }
    );
    assert_eq!(
        charged_attempts(&graph, &window)?,
        i64::from(restart && !stranded)
    );
    if settle {
        assert_eq!(
            window_count(&graph, &window, "error_code='memory_write_busy'"),
            1
        );
        let failures: i64 = sqlite::open(&graph)?.query_row("SELECT COUNT(*) FROM memory_projection_attempts WHERE window_ref=?1 AND state='failed' AND error_code='memory_write_busy'", [&window], |r| r.get(0))?;
        assert_eq!(
            failures, 4,
            "contention beyond the model cap must remain retryable"
        );
    }
    // A fixed clock before the retry deadline must not cause another provider call.
    let calls = user_calls(&s);
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(user_calls(&s), calls);
    jump_to(address, "2026-10-02T04:04:00.000Z".into()).await?;
    wake_source(&s.sandbox.data)?;
    until(|| window_count(&graph, &window, "state IN ('complete','failed')") == 1).await;
    let (commits, applies) = assert_applied_once(&graph, &window)?;
    memory_stubs::text_complete(&s.sandbox.data, 1).await?;
    s.provider()?.add_placeholder("SOURCE_SESSION", session);
    let recalled = fts::recall(&s).await?;
    assert_eq!(recalled["ok"], true, "{recalled}");
    assert!(
        recalled["output"]["results"].to_string().contains("amber"),
        "the recovered fact must be recalled: {recalled}"
    );
    assert!(
        !recalled.to_string().contains("ingestion_pending"),
        "{recalled}"
    );
    eprintln!(
        "MEM-PROJECTION-RETRY restart={restart} stranded={stranded} recovery_ms={} meaning_commits={commits} final_applies={applies}",
        started.elapsed().as_millis()
    );
    s.finish().await
}

/// The fixture clock does not wake timers. A native canonical change wakes the
/// consumer after the jump without waiting out its real 30-second idle cap.
/// No source content changes and no extra turn is introduced.
fn wake_source(data: &Path) -> Result<(), HarnessError> {
    let db = sqlite::open(data.join("runtime/conversation-store.sqlite"))?;
    db.execute(
        "UPDATE conversation_public_source_state SET revision=revision+1 WHERE singleton=1",
        [],
    )?;
    Ok(())
}

fn user_calls(s: &Scenario) -> usize {
    s.provider()
        .unwrap()
        .memory_requests()
        .iter()
        .filter(|request| {
            request["input"]
                .as_str()
                .or_else(|| request["input"][0]["content"][0]["text"].as_str())
                .is_some_and(|prompt| prompt.contains("\"speaker\":\"user\""))
        })
        .count()
}

fn assert_applied_once(graph: &Path, window: &str) -> Result<(i64, i64), HarnessError> {
    assert_eq!(
        window_count(graph, window, "state='complete' AND error_code IS NULL"),
        1
    );
    let db = sqlite::open(graph)?;
    let commits: i64 = db.query_row(
        "SELECT COUNT(*) FROM memory_meaning_commits WHERE window_ref=?1",
        [window],
        |r| r.get(0),
    )?;
    let applies: i64 = db.query_row(
        "SELECT COUNT(*) FROM memory_projection_attempts WHERE window_ref=?1 AND state='complete'",
        [window],
        |r| r.get(0),
    )?;
    assert_eq!((commits, applies), (1, 1));
    let facts: i64 = db.query_row("SELECT COUNT(*) FROM memory_claims c JOIN memory_nodes n ON n.id=c.node_id WHERE n.window_ref=?1", [window], |r| r.get(0))?;
    assert_eq!(facts, 1, "the recovered fact must be present exactly once");
    drop(db);
    Ok((commits, applies))
}

/// Three earlier write-contention settlements must not exhaust the model cap.
fn seed_contention_history(graph: &Path, window: &str, stranded: bool) -> Result<(), HarnessError> {
    let db = sqlite::open(graph)?;
    for attempt in 1..=3 {
        db.execute("INSERT INTO memory_projection_attempts(attempt_ref,window_ref,job_id,attempt_count,state,error_code,recorded_at,attempt_kind,provider_invoked,outcome_known,invocation_ref)
            SELECT window_ref||':busy:'||?2,window_ref,job_id,?2,'failed','memory_write_busy','2026-10-02T04:00:00.000Z','provider',1,1,'busy-'||?2 FROM memory_projection_windows WHERE window_ref=?1",
            rusqlite::params![window, attempt])?;
    }
    db.execute(
        "UPDATE memory_projection_windows SET attempt_count=4 WHERE window_ref=?1",
        [window],
    )?;
    if stranded {
        db.execute("UPDATE memory_projection_windows SET state='failed',error_code='memory_projection_outcome_unknown',owner_pid=NULL,owner_nonce=NULL,started_at=NULL WHERE window_ref=?1", [window])?;
        // This snapshot represents a graph last opened by the old schema policy.
        db.execute(
            "DELETE FROM memory_state WHERE key='projection_contention_recovery'",
            [],
        )?;
    }
    Ok(())
}

async fn jump_to(address: String, now: String) -> Result<(), HarnessError> {
    tokio::task::spawn_blocking(move || -> Result<(), HarnessError> {
        let mut stream = TcpStream::connect(address)?;
        stream.set_read_timeout(Some(Duration::from_secs(1)))?;
        writeln!(stream, "{now}")?;
        let mut reply = String::new();
        BufReader::new(stream).read_line(&mut reply)?;
        let value: serde_json::Value = serde_json::from_str(&reply)?;
        assert_eq!(value["now"], now);
        Ok(())
    })
    .await
    .map_err(|e| HarnessError(e.to_string()))?
}

fn window_count(graph: &Path, window: &str, condition: &str) -> i64 {
    sqlite::open_with_flags(graph, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .unwrap()
        .query_row(
            &format!(
                "SELECT COUNT(*) FROM memory_projection_windows WHERE window_ref=?1 AND {condition}"
            ),
            [window],
            |r| r.get(0),
        )
        .unwrap()
}

fn meaning(request: &serde_json::Value) -> butler_e2e::e2e::cassette::ResponseRecord {
    let prompt = request["input"]
        .as_str()
        .or_else(|| request["input"][0]["content"][0]["text"].as_str())
        .unwrap();
    let input: serde_json::Value = serde_json::from_str(prompt).unwrap();
    let items = if input["speaker"] == "user" {
        json!([{"kind":"preference","subject":null,"text":input["parts"][0]["text"],"evidence":[0]}])
    } else {
        json!([])
    };
    let text =
        json!({"status":"processed","entities":[],"items":items,"attributes":[]}).to_string();
    super::memory_response(
        &json!({"type":"message","id":"msg_retry_meaning","role":"assistant","status":"completed","content":[{"type":"output_text","text":text,"annotations":[]}]}),
    )
}

async fn expired_wait(
    observer: &tokio::net::TcpListener,
) -> Result<tokio::net::TcpStream, HarnessError> {
    use tokio::io::AsyncBufReadExt;
    tokio::time::timeout(Duration::from_secs(90), async {
        loop {
            let (stream, _) = observer.accept().await?;
            let mut reader = tokio::io::BufReader::new(stream);
            let mut purpose = String::new();
            reader.read_line(&mut purpose).await?;
            let mut stream = reader.into_inner();
            if purpose.trim() == "projection" {
                return Ok(stream);
            }
            acknowledge(&mut stream).await?;
        }
    })
    .await
    .map_err(|e| HarnessError(e.to_string()))?
}

async fn acknowledge(stream: &mut tokio::net::TcpStream) -> Result<(), HarnessError> {
    use tokio::io::AsyncWriteExt;
    stream.write_all(&[1]).await?;
    Ok(())
}

fn charged_attempts(graph: &Path, window: &str) -> Result<i64, HarnessError> {
    Ok(sqlite::open(graph)?.query_row("SELECT COUNT(DISTINCT invocation_ref) FROM memory_projection_attempts WHERE window_ref=?1 AND provider_invoked=1 AND (state='interrupted' OR (state='failed' AND error_code NOT IN ('memory_write_busy','memory_projection_outcome_unknown')))", [window], |r| r.get(0))?)
}
