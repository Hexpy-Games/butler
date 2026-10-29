use super::*;
use rusqlite::Connection;
use std::time::{Duration, Instant};

#[tokio::test]
async fn locked_cancel_does_not_block_replay_and_unlock_delivers() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, epic, source) =
        crate::canon_link::setup("CB-TAKE-LOCK", false, false).await?;
    data(
        s.gw.post(
            &format!("/sessions/{source}/canon/queue"),
            json!({"op":"start_now","epic_id":epic}),
        )
        .await?,
        200,
    );
    script.wait_held().await;
    let source_turn = first_turn(&s, &source).await?;
    let app = Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    let canon = Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    // Delay only the terminal App receipt, keeping execute's projection and
    // delivery guards held across Stop while the replay loop receives changes.
    app.execute_batch(&format!("CREATE TRIGGER delay_terminal BEFORE UPDATE OF state ON turns WHEN OLD.id='{source_turn}' AND NEW.state='cancelled' BEGIN SELECT RAISE(IGNORE); END;"))?;
    let target = session(&s).await?;
    let gw = s.gw.clone();
    let path = format!("/sessions/{target}/canon/queue/take/{epic}");
    let taking = tokio::spawn(async move { gw.post(&path, json!({})).await });
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let cancelling: bool = app.query_row(
            "SELECT state='cancelling' FROM turns WHERE id=?1",
            [&source_turn],
            |r| r.get(0),
        )?;
        if cancelling {
            break;
        }
        assert!(Instant::now() < deadline, "take did not reach Stop");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(!taking.is_finished());
    assert_eq!(pending(&canon)?, 1);
    // A second unresolved identity represents a source step which crashed
    // before App projection. Its op guard is free but the same delivery guard
    // is held by take, so it too must be retried when take releases it.
    canon.execute(
        "INSERT INTO canon_step_cancellations(op_id,epic_id,source_session_id) VALUES(?1,?2,?3)",
        rusqlite::params![
            uuid::Uuid::new_v4().to_string(),
            epic,
            butler_gateway::gateway::app_session_hint(&source)
        ],
    )?;
    script
        .quick
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let independent = session(&s).await?;
    let other = script.epics.lock().unwrap()[1].clone();
    data(
        s.gw.post(
            &format!("/sessions/{independent}/canon/queue"),
            json!({"op":"start_now","epic_id":other}),
        )
        .await?,
        200,
    );
    let turn = first_turn(&s, &independent).await?;
    s.gw.wait_terminal(&independent, &turn, Duration::from_secs(30))
        .await?;
    // Replaying the independent intent proves the locked cancellation was
    // skipped. It must still exist and the target must remain gated.
    assert_eq!(pending(&canon)?, 2);
    assert_eq!(s.gw.turns(&target).await?, [] as [serde_json::Value; 0]);
    assert!(!taking.is_finished());
    // Native cancellation is asynchronous even after the independent turn ends.
    // Keep the App receipt blocked until native Stop has actually completed.
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let cancelled = canon.query_row::<i64, _, _>(
            "SELECT count(*) FROM btcc_turns WHERE semantic_state='cancelled'",
            [],
            |r| r.get(0),
        )?;
        if cancelled == 1 {
            break;
        }
        assert!(Instant::now() < deadline, "native Stop did not complete");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    // Model an already reconciled source terminal receipt. The second skipped
    // identity must still gate the target, and execute's duplicate receipt is
    // now a no-op: only lock release can guarantee the retry.
    let source_op: String = app.query_row(
        "SELECT i.source_key FROM app_initiated_messages i JOIN turns t ON t.user_message_id=i.message_id WHERE t.id=?1",
        [&source_turn], |r| r.get(0),
    )?;
    assert_eq!(
        canon.execute(
            "DELETE FROM canon_step_cancellations WHERE op_id=?1",
            [&source_op]
        )?,
        1
    );
    assert_eq!(pending(&canon)?, 1);
    app.execute_batch("DROP TRIGGER delay_terminal")?;
    // Wake execute's terminal wait with an App-only event, so no native write
    // can mask a missing lock-release signal.
    app.execute(
        "UPDATE turns SET state='cancelled' WHERE id=?1",
        [&source_turn],
    )?;
    data(
        s.gw.patch(
            &format!("/sessions/{independent}"),
            json!({"title":"Renamed"}),
        )
        .await?,
        200,
    );
    data(
        tokio::time::timeout(Duration::from_secs(30), taking)
            .await
            .expect("take completed")
            .expect("take task")?,
        200,
    );
    let turn = first_turn(&s, &target).await?;
    s.gw.wait_terminal(&target, &turn, Duration::from_secs(30))
        .await?;
    assert_eq!(pending(&canon)?, 0);
    assert_eq!(s.gw.turns(&target).await?.len(), 1);
    drop((app, canon));
    script.release();
    s.finish().await?;
    server.abort();
    Ok(())
}
async fn session(s: &butler_e2e::e2e::scenario::Scenario) -> Result<String, HarnessError> {
    let row = data(
        s.gw.post("/sessions", json!({"title":"Another","kind":"chat"}))
            .await?,
        201,
    );
    Ok(row["session"]["id"].as_str().unwrap().to_owned())
}
fn pending(db: &Connection) -> rusqlite::Result<i64> {
    db.query_row("SELECT count(*) FROM canon_step_cancellations", [], |r| {
        r.get(0)
    })
}
