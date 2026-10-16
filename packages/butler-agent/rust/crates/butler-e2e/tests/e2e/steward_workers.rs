//! A Steward that waits for Workers after the last one answered keeps going:
//! the wait reports that no Worker is active, the Steward reports to Butler,
//! and the chat gets its answer. A wait an older build paused with nothing
//! outstanding is woken at startup.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
#[path = "steward_workers/stub.rs"]
mod stub;
use super::steward_interrupted_queue::{db, read_record, records};
use super::steward_presentation;
use butler_e2e::e2e::{HarnessError, scenario::Scenario};
use rusqlite::OptionalExtension;
use serde_json::Value;
use std::{
    sync::atomic::Ordering,
    time::{Duration, Instant},
};

/// (turn_id, semantic_state, suspension_reason) of a session, oldest first.
fn turns(s: &Scenario, session: &str) -> Vec<(String, String, Option<String>)> {
    let db = db(s);
    let mut statement = db
        .prepare(
            "SELECT turn_id,semantic_state,suspension_reason FROM btcc_turns \
             WHERE session_id=?1 ORDER BY rowid",
        )
        .unwrap();
    statement
        .query_map([session], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

async fn steward_session(s: &Scenario) -> Result<String, HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let view = s.gw.get("/session-view?session_id=general").await?;
        if let Some(id) = view.data()["steward_children"][0]["session_id"].as_str() {
            return Ok(id.to_owned());
        }
        assert!(Instant::now() < deadline, "{view:?}\n{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Waits until the Steward has `count` turns and the latest one paused.
async fn paused(s: &Scenario, steward: &str, count: usize) {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let rows = turns(s, steward);
        if rows.len() == count
            && rows.last().is_some_and(|(_, state, reason)| {
                state == "admitted" && reason.as_deref() == Some("waiting_for_worker")
            })
        {
            return;
        }
        assert!(
            rows.len() <= count && Instant::now() < deadline,
            "steward never paused with {count} turns: {rows:?}\n{}",
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Runs the assignment until the last Worker is released; returns the Steward.
async fn release_workers(s: &Scenario, script: &stub::Script) -> Result<String, HarnessError> {
    s.turn("general", stub::OWNER).await?;
    let steward = steward_session(s).await?;
    for released in 1..=stub::PARTS.len() {
        paused(s, &steward, released).await;
        script.released.send_replace(released);
    }
    Ok(steward)
}

async fn reported(s: &Scenario, steward: &str) -> Result<(), HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let messages = s.gw.messages("general").await?;
        let replies = messages
            .iter()
            .filter(|m| m["text"] == stub::BUTLER_REPLY && m["status"] == "delivered")
            .count();
        if replies == 1 && steward_result(s, steward).is_some() {
            return Ok(());
        }
        assert!(
            replies <= 1 && Instant::now() < deadline,
            "steward report never reached the chat: {:?}\n{messages:?}\n{}",
            turns(s, steward),
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// The Steward's one result to Butler: (status, summary).
fn steward_result(s: &Scenario, steward: &str) -> Option<(String, String)> {
    let db = db(s);
    let count: i64 = db
        .query_row(
            "SELECT count(*) FROM btcc_steward_results WHERE child_session_id=?1",
            [steward],
            |row| row.get(0),
        )
        .unwrap();
    assert!(count <= 1, "steward reported {count} times");
    db.query_row(
        "SELECT status,summary FROM btcc_steward_results WHERE child_session_id=?1",
        [steward],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
    .unwrap()
}

fn idle_waits_seen(script: &stub::Script) -> usize {
    script
        .requests
        .lock()
        .unwrap()
        .iter()
        .filter(|body| stub::last_output(body).contains("no_active_worker"))
        .count()
}

#[tokio::test]
async fn wait_after_the_last_worker_result_still_reports() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    let s = steward_presentation::setup("STEWARD-WAIT-NO-WORKER", &url)?
        .start()
        .await?;
    let steward = release_workers(&s, &script).await?;
    reported(&s, &steward).await?;
    let (status, summary) = steward_result(&s, &steward).unwrap();
    assert_eq!(status, "success");
    assert!(summary.contains(stub::STEWARD_REPORT), "{summary}");
    let rows = turns(&s, &steward);
    // The first turn and the first two Worker results paused; the last one
    // continued past its wait and delivered the report.
    assert_eq!(rows.len(), 4, "{rows:?}");
    assert_eq!(rows[3].1, "delivered", "{rows:?}");
    assert_eq!(rows[3].2, None, "{rows:?}");
    assert_eq!(idle_waits_seen(&script), 1);
    s.finish().await?;
    server.abort();
    Ok(())
}

/// Leaves the last Worker result's turn as an older build did: paused for a
/// Worker although none is outstanding, its queue entry settled.
fn pause_like_older_build(s: &Scenario, turn: &str) {
    let db = db(s);
    db.execute(
        "UPDATE btcc_state_claims SET status='consumed' WHERE turn_id=?1 AND status='active'",
        [turn],
    )
    .unwrap();
    db.execute(
        "UPDATE btcc_checkpoints SET is_active=0,active_claim_id=NULL WHERE turn_id=?1 AND is_active=1",
        [turn],
    )
    .unwrap();
    let changed = db
        .execute(
            "UPDATE btcc_turns SET suspension_reason='waiting_for_worker',authority_continuation_json=NULL,\
             active_checkpoint_id=NULL,revision=revision+1 WHERE turn_id=?1 AND semantic_state='admitted'",
            [turn],
        )
        .unwrap();
    assert_eq!(changed, 1, "last result turn is not admitted");
    let root = s.sandbox.data.join("runtime/inbound-events");
    let mut settled = 0;
    for path in records(&root, "processing") {
        let record = read_record(&path);
        if record
            .pointer("/envelope/routingHints/turnId")
            .and_then(Value::as_str)
            == Some(turn)
        {
            std::fs::create_dir_all(root.join("processed")).unwrap();
            std::fs::rename(
                &path,
                root.join("processed").join(path.file_name().unwrap()),
            )
            .unwrap();
            settled += 1;
        }
    }
    assert_eq!(settled, 1, "last result turn has no processing entry");
}

#[tokio::test]
async fn startup_wakes_a_wait_with_no_worker_left() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    script.hold_after_idle_wait.store(true, Ordering::SeqCst);
    let mut s = steward_presentation::setup("STEWARD-WAIT-WAKE", &url)?
        .start()
        .await?;
    let steward = release_workers(&s, &script).await?;
    tokio::time::timeout(Duration::from_secs(30), script.held.notified())
        .await
        .unwrap_or_else(|_| panic!("{:?}\n{}", turns(&s, &steward), s.agent.logs()));
    s.agent.kill9()?;
    let stuck = turns(&s, &steward).pop().unwrap().0;
    assert!(stuck.starts_with("worker-result-turn-"), "{stuck}");
    pause_like_older_build(&s, &stuck);
    s.gw = s.agent.start_again().await?;
    reported(&s, &steward).await?;
    let (status, summary) = steward_result(&s, &steward).unwrap();
    assert_eq!(status, "success");
    assert!(summary.contains(stub::STEWARD_REPORT), "{summary}");
    let rows = turns(&s, &steward);
    assert_eq!(rows.len(), 5, "{rows:?}");
    assert_eq!(rows[3].0, stuck);
    assert_eq!(rows[3].2.as_deref(), Some("waiting_for_worker"));
    assert!(rows[4].0.starts_with("worker-wait-wake-turn-"), "{rows:?}");
    assert_eq!(rows[4].1, "delivered", "{rows:?}");
    // Once before the crash, once in the woken turn.
    assert_eq!(idle_waits_seen(&script), 2);
    // Startup recovery runs before readiness: a second restart finds nothing
    // left to wake and queues nothing for the Steward.
    s.agent.kill9()?;
    s.gw = s.agent.start_again().await?;
    let root = s.sandbox.data.join("runtime/inbound-events");
    let queued: Vec<_> = ["pending", "processing"]
        .into_iter()
        .flat_map(|state| records(&root, state))
        .map(|path| read_record(&path))
        .filter(|record| {
            record
                .pointer("/envelope/routingHints/sessionId")
                .and_then(Value::as_str)
                == Some(steward.as_str())
        })
        .collect();
    assert!(queued.is_empty(), "{queued:?}");
    assert_eq!(turns(&s, &steward).len(), 5);
    s.finish().await?;
    server.abort();
    Ok(())
}
