//! Interrupted children preserve directions and the parent's entire queue.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use super::steward_presentation::{self, stub};
use butler_e2e::e2e::{HarnessError, scenario::Scenario};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::atomic::Ordering,
    time::{Duration, Instant},
};

#[tokio::test]
async fn shutdown_interrupted_child_returns_one_failure_and_runs_the_queue()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    interrupted_queue(false).await
}

#[tokio::test]
async fn crash_interrupted_child_returns_one_failure_and_runs_the_queue() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    interrupted_queue(true).await
}

async fn started(id: &str, url: &str, script: &stub::Script) -> Result<Scenario, HarnessError> {
    let setup = steward_presentation::setup(id, url)?;
    for name in ["a.txt", "b.txt"] {
        std::fs::write(setup.sandbox.data.join(name), name)?;
    }
    *script.workspace.lock().unwrap() = setup.sandbox.data.display().to_string();
    let s = setup.start().await?;
    s.turn("general", stub::OWNER).await?;
    tokio::time::timeout(Duration::from_secs(20), script.held.notified())
        .await
        .unwrap_or_else(|_| {
            panic!(
                "child never held requests={:?}\n{}",
                script
                    .requests
                    .lock()
                    .unwrap()
                    .iter()
                    .map(|r| butler_e2e::e2e::matching::key(
                        "/v1/responses",
                        r,
                        &Default::default()
                    )
                    .user_request)
                    .collect::<Vec<_>>(),
                s.agent.logs()
            )
        });
    Ok(s)
}

pub(super) fn db(s: &Scenario) -> Connection {
    Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite")).unwrap()
}

pub(super) fn count(db: &Connection, sql: &str, relation: &str) -> i64 {
    db.query_row(sql, [relation], |row| row.get(0)).unwrap()
}

pub(super) fn records(root: &Path, state: &str) -> Vec<PathBuf> {
    std::fs::read_dir(root.join(state))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect()
}

pub(super) fn read_record(path: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

async fn interrupted_queue(crash: bool) -> Result<(), HarnessError> {
    let (url, script, server) = stub::start().await?;
    let kind = if crash { "CRASH" } else { "SHUTDOWN" };
    let mut s = started(&format!("STEWARD-QUEUE-{kind}"), &url, &script).await?;
    let view = s.gw.get("/session-view?session_id=general").await?;
    let child = &view.data()["steward_children"][0];
    let relation = child["relation"]["relation_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let child_turn: String = db(&s)
        .query_row(
            "SELECT child_turn_id FROM btcc_subsession_delegations WHERE relation_id=?1",
            [&relation],
            |row| row.get(0),
        )
        .unwrap();
    *script.relation.lock().unwrap() = relation.clone();
    s.turn("general", stub::DIRECTION).await?;
    assert_eq!(
        count(
            &db(&s),
            "SELECT count(*) FROM btcc_subsession_directions WHERE relation_id=?1 AND status='pending'",
            &relation
        ),
        1
    );
    let held = s.gw.say_turn("general", stub::HOLD_PARENT).await?;
    tokio::time::timeout(Duration::from_secs(20), script.parent_held.notified())
        .await
        .unwrap();
    let queued =
        s.gw.post(
            "/session-queue",
            json!({
                "chat_id":"general", "text":stub::QUEUED,
                "client_message_id":uuid::Uuid::new_v4().to_string()
            }),
        )
        .await?;
    assert_eq!(queued.status, 202, "{queued:?}");
    let queue = s.gw.get("/session-queue?chat_id=general").await?;
    assert!(
        queue.data()["queued_messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["state"] == "queued" && item["turn_id"].is_null()),
        "{queue:?}"
    );
    if crash {
        s.crash_and_restart().await?;
    } else {
        s.restart().await?;
    }
    assert_drained(&s, &script, &relation, &child_turn, &held).await?;
    s.finish().await?;
    server.abort();
    Ok(())
}

async fn assert_drained(
    s: &Scenario,
    script: &stub::Script,
    relation: &str,
    child_turn: &str,
    held: &str,
) -> Result<(), HarnessError> {
    let started = Instant::now();
    let deadline = started + Duration::from_secs(60);
    let root = s.sandbox.data.join("runtime/inbound-events");
    loop {
        let db = db(s);
        let failed = count(
            &db,
            "SELECT count(*) FROM btcc_steward_results WHERE relation_id=?1 AND status='failed'",
            relation,
        );
        let success = count(
            &db,
            "SELECT count(*) FROM btcc_steward_results WHERE relation_id=?1 AND status='success'",
            relation,
        );
        let direction: String = db
            .query_row(
                "SELECT status FROM btcc_subsession_directions WHERE relation_id=?1",
                [relation],
                |row| row.get(0),
            )
            .unwrap();
        let messages = s.gw.messages("general").await?;
        let delivered = |text: &str| {
            messages
                .iter()
                .any(|m| m["text"] == text && m["status"] == "delivered")
        };
        let pending = records(&root, "pending").len();
        let processing = records(&root, "processing").len();
        if failed == 1
            && success == 1
            && direction == "applied"
            && delivered(stub::QUEUED_REPLY)
            && messages
                .iter()
                .filter(|m| m["text"] == "Approach B verified." && m["status"] == "delivered")
                .count()
                == 2
            && pending == 0
            && processing == 0
        {
            assert_eq!(
                count(
                    &db,
                    "SELECT count(*) FROM btcc_steward_results WHERE relation_id=?1",
                    relation
                ),
                2
            );
            let original: String = db.query_row("SELECT child_turn_id FROM btcc_steward_results WHERE relation_id=?1 AND status='failed'", [relation], |row| row.get(0)).unwrap();
            assert_eq!(original, child_turn);
            assert_eq!(
                count(
                    &db,
                    "SELECT count(*) FROM btcc_subsession_outbox WHERE relation_id=?1 AND input_json LIKE '%status: failed%'",
                    relation
                ),
                1
            );
            assert_requests(script);
            assert_eq!(script.hold_seen.load(Ordering::SeqCst), 1);
            let turn = s.gw.turn("general", held).await?.unwrap();
            assert_eq!(turn["state"], "failed", "{turn}");
            assert_eq!(turn["retryable"], true, "{turn}");
            let view = s.gw.get("/session-view?session_id=general").await?;
            assert!(view.data().to_string().contains(held), "{view:?}");
            for path in records(&root, "failed") {
                let record = read_record(&path);
                let turn = record
                    .pointer("/envelope/routingHints/turnId")
                    .and_then(Value::as_str)
                    .unwrap();
                assert!(
                    turn == child_turn || turn == held,
                    "unexpected failed follow-up: {record}"
                );
            }
            println!(
                "full queue recovered ({:.3}s): failed=1 success=1 direction={direction} pending={pending} processing={processing}",
                started.elapsed().as_secs_f64()
            );
            return Ok(());
        }
        assert!(
            Instant::now() < deadline,
            "queue not drained: failed={failed} success={success} direction={direction} pending={pending} processing={processing} messages={messages:?}\n{}",
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

pub(super) fn request_text(body: &Value) -> String {
    butler_e2e::e2e::matching::key("/v1/responses", body, &Default::default()).user_request
}

fn assert_requests(script: &stub::Script) {
    let requests = script.requests.lock().unwrap();
    assert_eq!(
        requests
            .iter()
            .filter(|r| {
                let text = request_text(r);
                text.contains("Delegated result")
                    && text.contains("status: failed")
                    && text.contains("child_turn_interrupted")
            })
            .count(),
        1,
        "failed result delivered more than once"
    );
    assert!(
        requests
            .iter()
            .any(|r| stub::child_lane(r) && request_text(r).starts_with(stub::DIRECTION)),
        "direction never ran as a child continuation"
    );
}

#[tokio::test]
async fn restart_close_keeps_a_saved_success_result() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    let mut s = started("STEWARD-QUEUE-SAVED", &url, &script).await?;
    script.release.notify_one();
    let child = steward_presentation::wait_result(&s).await?;
    assert_eq!(child["result"]["status"], "success");
    let relation = child["relation"]["relation_id"].as_str().unwrap();
    let child_session = child["session_id"].as_str().unwrap();
    let child_turn: String = db(&s)
        .query_row(
            "SELECT child_turn_id FROM btcc_subsession_delegations WHERE relation_id=?1",
            [relation],
            |row| row.get(0),
        )
        .unwrap();
    let pid = s.agent.pid().unwrap();
    s.agent.kill9()?;
    let root = s.sandbox.data.join("runtime/inbound-events");
    let path = records(&root, "processed")
        .into_iter()
        .find(|path| {
            let r = read_record(path);
            r["envelope"]["peer"]["id"] == child_session
                && r["envelope"]["routingHints"]["turnId"] == child_turn
        })
        .expect("processed child claim");
    let mut record = read_record(&path);
    record["processing"] = json!({
        "claimId":"e2e-crash", "ownerId":format!("{pid}:e2e"),
        "claimedAt":"2026-01-01T00:00:00.000Z", "leaseExpiresAt":"2999-01-01T00:00:00.000Z"
    });
    let name = path.file_name().unwrap();
    std::fs::write(
        root.join("processing").join(name),
        serde_json::to_vec(&record).unwrap(),
    )?;
    std::fs::remove_file(&path)?;
    s.gw = s.agent.start_again().await?;
    let deadline = Instant::now() + Duration::from_secs(60);
    while !root.join("failed").join(name).exists() {
        assert!(
            Instant::now() < deadline,
            "saved claim not closed\n{}",
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let db = db(&s);
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM btcc_steward_results WHERE relation_id=?1",
            relation
        ),
        1
    );
    let (status, failure_key): (String, Option<String>) = db
        .query_row(
            "SELECT status,failure_key FROM btcc_steward_results WHERE relation_id=?1",
            [relation],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(status, "success");
    assert_eq!(failure_key, None, "restart close re-keyed a saved success");
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM btcc_subsession_outbox WHERE relation_id=?1",
            relation
        ),
        1
    );
    assert_eq!(
        script
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|r| request_text(r).contains("Delegated result"))
            .count(),
        1
    );
    drop(db);
    s.finish().await?;
    server.abort();
    Ok(())
}
