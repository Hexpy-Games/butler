//! Ended Worker tasks cannot resume invisibly under their old card.
use super::*;
use crate::worker_cap::{setup, started, workers};
use std::sync::atomic::Ordering;

#[tokio::test]
async fn finished_worker_followup_is_refused() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    followup(false).await
}
#[tokio::test]
async fn cancelled_worker_followup_is_refused() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    followup(true).await
}

async fn followup(cancelled: bool) -> Result<(), HarnessError> {
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
            super::terminal::assert_closed(&db, session);
            break;
        }
        assert!(Instant::now() < deadline, "{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let worker_requests = script
        .requests
        .lock()
        .unwrap()
        .iter()
        .filter(|(role, _)| role == "worker")
        .count();
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
    assert_eq!(
        script
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|(role, _)| role == "worker")
            .count(),
        worker_requests,
        "Worker stub must receive no request after its result"
    );
    for n in 0..4 {
        script.release(&format!("red-{n}"));
    }
    script.fourth.add_permits(1);
    s.finish().await?;
    server.abort();
    Ok(())
}
