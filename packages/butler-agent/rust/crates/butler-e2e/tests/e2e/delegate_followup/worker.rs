//! A completed turn with an open root Work can receive a Worker direction.
use super::*;
use crate::worker_cap::{closed, setup, started, workers};
use std::sync::atomic::Ordering;

#[tokio::test]
async fn finished_worker_followup_reenters_cap_fifo() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    followup(false, false).await
}

#[tokio::test]
async fn historical_finished_worker_without_intent_accepts_followup() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    followup(true, false).await
}

#[tokio::test]
async fn cancelled_first_worker_followup_runs_as_continuation() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    followup(false, true).await
}

async fn followup(historical: bool, cancelled: bool) -> Result<(), HarnessError> {
    let (s, script, server) = setup("FOLLOWUP-WORKER", 4).await?;
    script.steer.store(true, Ordering::SeqCst);
    script.followup.store(true, Ordering::SeqCst);
    s.gw.say("general", "Verify batch red").await?;
    let (parent, rows) = workers(&s, "general", 3).await?;
    started(&script, 2).await;
    if cancelled {
        crate::worker_cap::recovery::cancel_worker(&s, &rows[0]).await?;
    } else {
        script.release("red-0");
    }
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
        let failed: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM btcc_steward_results x JOIN btcc_subsession_outbox o USING(result_id) WHERE x.relation_id=?1 AND x.status=?2 AND o.status='delivered')", rusqlite::params![rows[0]["relation"]["relation_id"].as_str().unwrap(), if cancelled {"cancelled"} else {"success"}], |r| r.get(0))?;
        if failed {
            break;
        }
        assert!(Instant::now() < deadline, "{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    if cancelled {
        script.release("red-0");
    }
    started(&script, 3).await;
    if historical {
        // Rows predating durable dispatch intents retain main's direct-by-id behaviour.
        let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
        db.execute(
            "UPDATE btcc_subsession_delegations SET dispatch_intent_json=NULL WHERE relation_id=?1",
            [rows[0]["relation"]["relation_id"].as_str().unwrap()],
        )?;
    }
    script.direction.add_permits(1);
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
        let state: Option<String> = db.query_row(
            "SELECT dispatch_state FROM btcc_subsession_delegations WHERE relation_id=?1",
            [rows[0]["relation"]["relation_id"].as_str().unwrap()],
            |r| r.get(0),
        )?;
        if script.steered.load(Ordering::SeqCst) {
            assert_eq!(
                state.as_deref(),
                Some("pending"),
                "finished Worker must wait for a slot"
            );
            let view =
                s.gw.get(&format!("/session-view?session_id={parent}"))
                    .await?;
            let child = view.data()["workers"]
                .as_array()
                .unwrap()
                .iter()
                .find(|child| child["session_id"] == rows[0]["session_id"])
                .unwrap();
            assert_eq!(child["status"], "waiting");
            assert_eq!(child["waiting_for_slot"], true);
            break;
        }
        assert!(Instant::now() < deadline, "{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    script.release("red-1");
    tokio::time::timeout(Duration::from_secs(30), script.continued.wait())
        .await
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
        let completed: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM btcc_steward_results x JOIN btcc_subsession_delegations d USING(relation_id) WHERE x.relation_id=?1 AND x.child_turn_id<>d.child_turn_id AND x.status='success')", [rows[0]["relation"]["relation_id"].as_str().unwrap()], |r| r.get(0))?;
        if completed {
            break;
        }
        assert!(Instant::now() < deadline, "{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    script.release("red-2");
    script.fourth.add_permits(1);
    started(&script, 4).await;
    script.release("red-3");
    let (_, rows) = workers(&s, "general", 4).await?;
    closed(&s, rows[3]["session_id"].as_str().unwrap()).await?;
    s.finish().await?;
    server.abort();
    Ok(())
}
