//! A result is delivered even when its consuming turn suspends or fails.
use super::*;

#[tokio::test]
async fn suspended_after_worker_result_settles_delivery() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    result_ends(1).await
}

#[tokio::test]
async fn failed_after_worker_result_settles_delivery() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    result_ends(2).await
}

async fn result_ends(ending: u8) -> Result<(), HarnessError> {
    let (s, script, server, assigned) = start_mode("WMU-RESULT-END", false, true).await?;
    script.result_ending.store(ending, Ordering::SeqCst);
    script.release_child.notify_one();
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let state = super::super::database(&s, |db| db.query_row(
            "SELECT coalesce(t.suspension_reason,t.semantic_state) FROM btcc_turns t WHERE t.original_message_id LIKE 'worker-result-message:%' ORDER BY t.rowid DESC LIMIT 1",
            [], |r| r.get::<_, String>(0))).await;
        if state
            .as_ref()
            .is_ok_and(|state| matches!(state.as_str(), "waiting_for_worker" | "delivered"))
        {
            break;
        }
        assert!(Instant::now() < deadline, "{state:?}\n{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let pending = super::super::database(&s, |db| db.query_row(
            "SELECT count(*) FROM wm_delegation_reports WHERE delivered_at IS NOT NULL AND delivery_ended_at IS NULL",
            [], |r| r.get::<_, i64>(0))).await?;
        if pending == 0 {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "result delivery stranded after ending {ending}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    if ending == 1 {
        script.result_ending.store(0, Ordering::SeqCst);
        s.turn("general", stub::STEER).await?;
    }
    wait_completed(&s, &assigned["task"]).await?;
    s.turn("general", stub::SECOND).await?;
    let later = super::super::database(&s, |db| {
        db.query_row("SELECT status FROM wm_tasks WHERE step_index=1", [], |r| {
            r.get::<_, String>(0)
        })
    })
    .await?;
    assert_eq!(
        later, "running",
        "the following step is released after reporting"
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn failed_parent_after_result_releases_the_following_step() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, assigned) = start("WMU-FAILED-RESULT-PARENT", false).await?;
    script.result_ending.store(3, Ordering::SeqCst);
    super::super::database(&s, |db| {
        db.execute_batch(
            "CREATE TRIGGER fail_result_journal BEFORE INSERT ON btcc_guided_tool_calls
         WHEN NEW.tool_name='work_read' AND EXISTS(SELECT 1 FROM wm_tasks WHERE status='completed')
         BEGIN SELECT RAISE(ABORT,'injected result journal failure'); END;",
        )
    })
    .await?;
    script.release_child.notify_one();
    wait_completed(&s, &assigned["task"]).await?;
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let turns = s.gw.turns("general").await?;
        if turns
            .iter()
            .any(|turn| turn["state"] == "failed" && turn["safe_error_code"] == "turn_interrupted")
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the result-carrying parent must fail: {turns:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    super::super::database(&s, |db| {
        db.execute_batch("DROP TRIGGER fail_result_journal")
    })
    .await?;
    script.result_ending.store(0, Ordering::SeqCst);
    s.turn("general", stub::SECOND).await?;
    let later = super::super::database(&s, |db| {
        db.query_row("SELECT status FROM wm_tasks WHERE step_index=1", [], |r| {
            r.get::<_, String>(0)
        })
    })
    .await?;
    assert_eq!(later, "running");
    s.finish().await?;
    server.abort();
    Ok(())
}
