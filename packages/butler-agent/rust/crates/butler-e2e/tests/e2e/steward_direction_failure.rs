//! A direction whose continuation turn ends before its first model round is
//! settled by that turn's failed result: the parent gets the failure once,
//! the direction never runs again, and later directions still run.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use super::steward_interrupted_queue::{count, db, read_record, records, request_text};
use super::steward_presentation::{self, stub};
use butler_e2e::e2e::{HarnessError, scenario::Scenario};
use serde_json::{Value, json};
use std::{
    sync::atomic::Ordering,
    time::{Duration, Instant},
};

type Direction = (String, String, Option<String>);

fn directions(s: &Scenario, relation: &str) -> Vec<Direction> {
    let db = db(s);
    let mut statement = db
        .prepare(
            "SELECT instruction,status,applied_child_turn_id FROM btcc_subsession_directions \
             WHERE relation_id=?1 ORDER BY revision",
        )
        .unwrap();
    statement
        .query_map([relation], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

fn result_status(s: &Scenario, relation: &str, turn: &str) -> Option<String> {
    use rusqlite::OptionalExtension;
    db(s)
        .query_row(
            "SELECT status FROM btcc_steward_results WHERE relation_id=?1 AND child_turn_id=?2",
            [relation, turn],
            |row| row.get(0),
        )
        .optional()
        .unwrap()
}

/// Puts the first direction back to pending while the agent is down.
fn reopen_first_direction(s: &Scenario, relation: &str) {
    let changed = db(s)
        .execute(
            "UPDATE btcc_subsession_directions SET status='pending',applied_at=NULL,\
             applied_child_turn_id=NULL WHERE relation_id=?1 AND instruction=?2",
            [relation, stub::DIRECTION],
        )
        .unwrap();
    assert_eq!(changed, 1, "first direction missing");
}

fn child_requests(script: &stub::Script, from: usize, prefix: &str) -> usize {
    script.requests.lock().unwrap()[from..]
        .iter()
        .filter(|r| stub::child_lane(r) && request_text(r).starts_with(prefix))
        .count()
}

fn interrupted_results(script: &stub::Script) -> usize {
    script
        .requests
        .lock()
        .unwrap()
        .iter()
        .filter(|r| {
            let text = request_text(r);
            text.contains("Delegated result")
                && text.contains("status: failed")
                && text.contains("child_turn_interrupted")
        })
        .count()
}

async fn delivered(s: &Scenario, text: &str) -> Result<usize, HarnessError> {
    Ok(s.gw
        .messages("general")
        .await?
        .iter()
        .filter(|m| m["text"] == text && m["status"] == "delivered")
        .count())
}

fn drained(s: &Scenario) -> bool {
    let root = s.sandbox.data.join("runtime/inbound-events");
    records(&root, "pending").is_empty() && records(&root, "processing").is_empty()
}

#[tokio::test]
async fn failed_direction_continuation_settles_and_the_next_direction_runs()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    // A blocked first result keeps the Work open, so the idle relation takes
    // the direction as a continuation turn.
    script.blocked_disposition.store(true, Ordering::SeqCst);
    script.release.notify_one();
    let setup = steward_presentation::setup("STEWARD-DIRECTION-FAILED", &url)?;
    for name in ["a.txt", "b.txt"] {
        std::fs::write(setup.sandbox.data.join(name), name)?;
    }
    *script.workspace.lock().unwrap() = setup.sandbox.data.display().to_string();
    let mut s = setup.start().await?;
    s.turn("general", stub::OWNER).await?;
    let child = steward_presentation::wait_result(&s).await?;
    assert_eq!(child["result"]["status"], "blocked", "{child}");
    let relation = child["relation"]["relation_id"]
        .as_str()
        .unwrap()
        .to_owned();
    *script.relation.lock().unwrap() = relation.clone();
    script.hold_direction.store(true, Ordering::SeqCst);
    s.turn("general", stub::DIRECTION).await?;
    tokio::time::timeout(Duration::from_secs(20), script.direction_held.notified())
        .await
        .unwrap_or_else(|_| {
            panic!(
                "continuation never reached the provider\n{}",
                s.agent.logs()
            )
        });
    let continuation = match &directions(&s, &relation)[..] {
        [(_, status, Some(turn))] if status == "applied" => turn.clone(),
        other => panic!("continuation did not take its direction: {other:?}"),
    };
    // The whole parent queue sits behind the crash: a held turn and a follow-up.
    let held = s.gw.say_turn("general", stub::HOLD_PARENT).await?;
    tokio::time::timeout(Duration::from_secs(20), script.parent_held.notified())
        .await
        .unwrap();
    let queued =
        s.gw.post(
            "/session-queue",
            json!({"chat_id":"general","text":stub::QUEUED,
                "client_message_id":uuid::Uuid::new_v4().to_string()}),
        )
        .await?;
    assert_eq!(queued.status, 202, "{queued:?}");
    s.agent.kill9()?;
    // The stub provider is reached only after steering took the direction, so
    // restore what a crash before that first model round leaves durable: the
    // claimed continuation with its direction still pending.
    reopen_first_direction(&s, &relation);
    let restarted = script.requests.lock().unwrap().len();
    s.gw = s.agent.start_again().await?;
    first_failure_returned(&s, &script, &relation, &continuation, &held).await?;
    s.turn("general", stub::DIRECTION_2).await?;
    second_direction_ran(&s, &script, &relation, &continuation, restarted).await?;
    // A closeout saved before directions settled with it recovers at startup.
    s.agent.kill9()?;
    reopen_first_direction(&s, &relation);
    s.gw = s.agent.start_again().await?;
    reopened_direction_settles(&s, &script, &relation, &continuation, restarted).await?;
    s.finish().await?;
    server.abort();
    Ok(())
}

async fn first_failure_returned(
    s: &Scenario,
    script: &stub::Script,
    relation: &str,
    continuation: &str,
    held: &str,
) -> Result<(), HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let failed = result_status(s, relation, continuation);
        if failed.as_deref() == Some("failed")
            && delivered(s, stub::QUEUED_REPLY).await? == 1
            && delivered(s, "Approach B verified.").await? == 2
            && drained(s)
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "first direction's failure not returned: result={failed:?} directions={:?}\n{}",
            directions(s, relation),
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(
        interrupted_results(script),
        1,
        "failed result delivered more than once"
    );
    assert_eq!(script.hold_seen.load(Ordering::SeqCst), 1);
    let turn = s.gw.turn("general", held).await?.unwrap();
    assert_eq!(turn["state"], "failed", "{turn}");
    assert_eq!(turn["retryable"], true, "{turn}");
    let root = s.sandbox.data.join("runtime/inbound-events");
    for path in records(&root, "failed") {
        let record = read_record(&path);
        let turn = record
            .pointer("/envelope/routingHints/turnId")
            .and_then(Value::as_str)
            .unwrap();
        assert!(
            turn == continuation || turn == held,
            "unexpected failed record: {record}"
        );
    }
    Ok(())
}

async fn second_direction_ran(
    s: &Scenario,
    script: &stub::Script,
    relation: &str,
    continuation: &str,
    restarted: usize,
) -> Result<(), HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(60);
    let second = loop {
        let rows = directions(s, relation);
        if let [_, (_, status, Some(turn))] = &rows[..]
            && status == "applied"
            && result_status(s, relation, turn).is_some()
            && delivered(s, "Approach B verified.").await? == 3
            && drained(s)
        {
            break turn.clone();
        }
        assert!(
            Instant::now() < deadline,
            "second direction never ran: directions={rows:?}\n{}",
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    let rows = directions(s, relation);
    assert_eq!(
        rows[0],
        (
            stub::DIRECTION.to_owned(),
            "applied".to_owned(),
            Some(continuation.to_owned())
        )
    );
    assert_eq!(rows[1].0, stub::DIRECTION_2);
    assert_ne!(second, continuation);
    assert_eq!(
        child_requests(script, restarted, stub::DIRECTION),
        0,
        "first direction ran again"
    );
    assert!(
        child_requests(script, restarted, stub::DIRECTION_2) >= 1,
        "second direction never reached the child"
    );
    assert_settled_once(s, script, relation);
    Ok(())
}

async fn reopened_direction_settles(
    s: &Scenario,
    script: &stub::Script,
    relation: &str,
    continuation: &str,
    restarted: usize,
) -> Result<(), HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let rows = directions(s, relation);
        if rows[0].1 == "applied" && rows[0].2.as_deref() == Some(continuation) && drained(s) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "reopened direction not settled at startup: {rows:?}\n{}",
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(
        child_requests(script, restarted, stub::DIRECTION),
        0,
        "first direction ran again"
    );
    assert_settled_once(s, script, relation);
    Ok(())
}

/// Three child results (first turn, failed continuation, second direction),
/// each delivered to the parent exactly once.
fn assert_settled_once(s: &Scenario, script: &stub::Script, relation: &str) {
    let db = db(s);
    let one = |sql: &str| count(&db, sql, relation);
    assert_eq!(
        one("SELECT count(*) FROM btcc_steward_results WHERE relation_id=?1"),
        3
    );
    assert_eq!(
        one("SELECT count(*) FROM btcc_subsession_outbox WHERE relation_id=?1"),
        3
    );
    assert_eq!(
        one(
            "SELECT count(*) FROM btcc_subsession_outbox WHERE relation_id=?1 AND input_json LIKE '%child_turn_interrupted%'"
        ),
        1
    );
    assert_eq!(
        interrupted_results(script),
        1,
        "failed result delivered more than once"
    );
}
