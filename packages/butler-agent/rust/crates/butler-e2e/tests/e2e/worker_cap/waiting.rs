//! Child waits use durable queue continuations, including completion before parking.
use super::*;
use std::sync::atomic::Ordering;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

pub(super) fn response(
    role: &str,
    request: &str,
    step: usize,
    count: usize,
    body: &Value,
) -> Value {
    match role {
        "parent" if request.starts_with("Delegated result") => {
            stub::message("All evidence verified.")
        }
        "parent" => stub::parent(step, "red"),
        "steward" => stub::steward(
            if request.starts_with("Delegated result") {
                count + 2 + step
            } else {
                step
            },
            "red",
            count,
            body,
        ),
        _ => stub::worker(step, body),
    }
}

async fn start(
    count: usize,
    barrier: Option<&str>,
) -> Result<
    (
        Scenario,
        std::sync::Arc<stub::Script>,
        tokio::task::JoinHandle<()>,
    ),
    HarnessError,
> {
    let (url, script, server) = stub::start(count).await?;
    script.wait_regression.store(true, Ordering::SeqCst);
    let mut setup = Setup::new("WORKER-WAIT")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", url);
    if let Some(address) = barrier {
        setup = setup.env("BUTLER_TEST_PAUSE_ADDR", address);
    }
    let s = setup.start().await?;
    Ok((s, script, server))
}

#[tokio::test]
async fn all_results_then_wait_continues_and_reaches_top_level_parent() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let (s, script, server) = start(2, None).await?;
    s.gw.say("general", "Verify batch red").await?;
    let (steward, rows) = workers(&s, "general", 2).await?;
    started(&script, 2).await;
    script.release("red-0");
    closed(&s, rows[0]["session_id"].as_str().unwrap()).await?;
    // The first result is consumed and its Steward waits for the remaining child.
    wait_until(&s, "SELECT count(*) >= 2 AND (SELECT suspension_reason='waiting_for_worker' FROM btcc_turns WHERE session_id=?1 ORDER BY rowid DESC LIMIT 1) FROM btcc_turns WHERE session_id=?1", &steward).await?;
    script.release("red-1");
    closed(&s, rows[1]["session_id"].as_str().unwrap()).await?;
    assert_final(&s, &script, &steward, 2).await?;
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn a_finished_workers_continuation_still_needs_a_result() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server) = setup("WORKER-WAIT-CONTINUATION", 4).await?;
    script.steer.store(true, Ordering::SeqCst);
    script.followup.store(true, Ordering::SeqCst);
    script.hold_continuation.store(true, Ordering::SeqCst);
    s.gw.say("general", "Verify batch red").await?;
    let (steward, rows) = workers(&s, "general", 3).await?;
    started(&script, 2).await;
    script.release("red-0");
    closed(&s, rows[0]["session_id"].as_str().unwrap()).await?;
    started(&script, 3).await;
    script.direction.add_permits(1);
    let deadline = Instant::now() + Duration::from_secs(30);
    while !script.steered.load(Ordering::SeqCst) {
        assert!(Instant::now() < deadline, "{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    script.release("red-1");
    tokio::time::timeout(Duration::from_secs(30), script.continued.wait())
        .await
        .expect("the direction opened its Worker turn");
    script.fourth.add_permits(1);
    let (_, rows) = workers(&s, "general", 4).await?;
    script.release("red-2");
    started(&script, 4).await;
    script.release("red-3");
    for row in &rows[1..] {
        closed(&s, row["session_id"].as_str().unwrap()).await?;
    }
    // Every original child has answered, but a continued turn is held in the
    // provider. All four result continuations must still park their Steward.
    wait_until(&s, "SELECT count(*) >= 5 AND (SELECT suspension_reason='waiting_for_worker' FROM btcc_turns WHERE session_id=?1 ORDER BY rowid DESC LIMIT 1) FROM btcc_turns WHERE session_id=?1", &steward).await?;
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let ended: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM btcc_steward_results WHERE child_session_id=?1)",
        [&steward],
        |r| r.get(0),
    )?;
    assert!(!ended, "the Steward must wait for its continued Worker");
    script.continuation_release.add_permits(1);
    wait_until(&s, "SELECT EXISTS(SELECT 1 FROM btcc_steward_results WHERE child_session_id=?1 AND status='success')", &steward).await?;
    wait_until(&s, "SELECT EXISTS(SELECT 1 FROM btcc_subsession_outbox WHERE parent_session_id=(SELECT parent_session_id FROM btcc_session_relations WHERE child_session_id=?1) AND status='delivered')", &steward).await?;
    s.finish().await?;
    server.abort();
    Ok(())
}

// test-category: race
#[tokio::test]
async fn child_completion_between_wait_check_and_suspend_is_queued() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?.to_string();
    let (tx, mut held) = tokio::sync::mpsc::unbounded_channel();
    let barrier = tokio::spawn(async move {
        let mut sent = false;
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            let mut reader = BufReader::new(stream);
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            let (point, turn) = line.trim().split_once('\t').unwrap();
            if !sent && point == "child_wait_checked" && turn.starts_with("steward-turn-") {
                sent = true;
                tx.send(reader.into_inner()).unwrap();
            } else {
                reader.write_all(b"1").await.unwrap();
            }
        }
    });
    let (s, script, server) = start(1, Some(&address)).await?;
    s.gw.say("general", "Verify batch red").await?;
    let (steward, rows) = workers(&s, "general", 1).await?;
    started(&script, 1).await;
    let mut pause = tokio::time::timeout(Duration::from_secs(30), held.recv())
        .await
        .unwrap()
        .unwrap();
    script.release("red-0");
    closed(&s, rows[0]["session_id"].as_str().unwrap()).await?;
    // The child has committed its result and queued a continuation while the
    // Steward still holds its active session claim, before suspension commits.
    wait_until(&s, "SELECT EXISTS(SELECT 1 FROM btcc_subsession_outbox WHERE parent_session_id=?1 AND status='delivered')", &steward).await?;
    pause.write_all(b"1").await?;
    assert_final(&s, &script, &steward, 1).await?;
    s.finish().await?;
    server.abort();
    barrier.abort();
    Ok(())
}

async fn wait_until(s: &Scenario, sql: &str, session: &str) -> Result<(), HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
        if db
            .query_row(sql, [session], |row| row.get::<_, Option<bool>>(0))?
            .unwrap_or(false)
        {
            return Ok(());
        }
        assert!(Instant::now() < deadline, "{sql}\n{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn assert_final(
    s: &Scenario,
    script: &stub::Script,
    steward: &str,
    count: usize,
) -> Result<(), HarnessError> {
    wait_until(s, "SELECT EXISTS(SELECT 1 FROM btcc_steward_results WHERE child_session_id=?1 AND status='success')", steward).await?;
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let messages = s.gw.messages("general").await?;
        if messages
            .iter()
            .any(|m| m["role"] == "assistant" && m["text"] == "All evidence verified.")
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "{messages:?}\n{}",
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let requests = script.requests.lock().unwrap();
    let no_active = |body: &Value| body.to_string().contains("no_active_worker");
    assert!(
        requests
            .iter()
            .any(|(role, body)| role == "steward" && no_active(body))
    );
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let delivered: usize = db.query_row("SELECT count(*) FROM btcc_subsession_outbox WHERE parent_session_id=?1 AND status='delivered'", [steward], |r| r.get(0))?;
    assert_eq!(delivered, count);
    Ok(())
}
