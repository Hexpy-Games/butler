use super::*;
use rusqlite::Connection;
use std::time::{Duration, Instant};

#[tokio::test]
async fn locked_cancel_does_not_block_replay_and_next_change_delivers() -> Result<(), HarnessError>
{
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
    // is held by take, so it too must survive until a later change.
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
    app.execute_batch("DROP TRIGGER delay_terminal")?;
    // A later change settles Stop and delivers the moved step exactly once.
    data(
        s.gw.post(&format!("/turns/{source_turn}/cancel"), json!({}))
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
    let changed = s.gw.say(&independent, "What does this mean?").await?;
    let changed = butler_e2e::e2e::scenario::accepted_turn_id(&changed)?;
    s.gw.wait_terminal(&independent, &changed, Duration::from_secs(30))
        .await?;
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
