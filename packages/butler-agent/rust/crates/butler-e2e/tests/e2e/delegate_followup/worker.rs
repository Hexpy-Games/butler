//! Ended Worker tasks cannot resume invisibly under their old card.
use super::*;
use crate::worker_cap::{setup, started, workers};
use std::sync::atomic::Ordering;

#[tokio::test]
async fn finished_worker_followup_is_refused() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    followup(false, false).await
}
#[tokio::test]
async fn historical_finished_worker_without_intent_refuses_followup() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    followup(true, false).await
}
#[tokio::test]
async fn cancelled_worker_followup_is_refused() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    followup(false, true).await
}

async fn followup(historical: bool, cancelled: bool) -> Result<(), HarnessError> {
    let (s, script, server) = setup("FOLLOWUP-WORKER", 4).await?;
    script.steer.store(true, Ordering::SeqCst);
    script.followup.store(true, Ordering::SeqCst);
    s.gw.say("general", "Verify batch red").await?;
    let (_, rows) = workers(&s, "general", 3).await?;
    started(&script, 2).await;
    let relation = rows[0]["relation"]["relation_id"].as_str().unwrap();
    let session = rows[0]["session_id"].as_str().unwrap();
    if cancelled {
        crate::worker_cap::recovery::cancel_worker(&s, &rows[0]).await?;
    } else {
        script.release("red-0");
    }
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
        let delivered: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM btcc_subsession_outbox WHERE relation_id=?1 AND status='delivered')", [relation], |r| r.get(0))?;
        if delivered {
            assert!(butler_turn::btcc::storage::terminal_card_invariant(&db, session).unwrap());
            if historical {
                db.execute("UPDATE btcc_subsession_delegations SET dispatch_intent_json=NULL WHERE relation_id=?1", [relation])?;
            }
            break;
        }
        assert!(Instant::now() < deadline, "{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    script.direction.add_permits(1);
    loop {
        let refused = script.requests.lock().unwrap().iter().any(|(_, request)| {
            request["input"].as_array().is_some_and(|items| {
                items.iter().any(|i| {
                    i["output"]
                        .as_str()
                        .is_some_and(|o| o.contains("delegated_session_closed"))
                })
            })
        });
        if refused {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "steer was not refused\n{}",
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let turns: i64 = db.query_row(
        "SELECT count(*) FROM btcc_turns WHERE session_id=?1",
        [session],
        |r| r.get(0),
    )?;
    assert_eq!(turns, 1, "a finished Worker must not get another turn");
    for n in 0..4 {
        script.release(&format!("red-{n}"));
    }
    script.fourth.add_permits(1);
    s.finish().await?;
    server.abort();
    Ok(())
}
