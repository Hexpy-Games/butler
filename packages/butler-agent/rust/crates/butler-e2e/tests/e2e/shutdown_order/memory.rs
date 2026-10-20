//! Background memory work must stop before a blocked interactive drain.

use super::*;

#[tokio::test]
async fn stop_cancels_memory_before_waiting_for_blocked_turn_storage() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    if !butler_platform::process_control::SIGNALS {
        return Ok(());
    }
    let id = "SHUTDOWN-MEMORY";
    let setup = Setup::new(id)?.env("BUTLER_E2E_HOLD_MEMORY_BOOTSTRAP", "1");
    let (mut s, _) = super::streaming_with_setup(setup).await?;
    let db = sqlite::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))
        .map_err(|e| HarnessError(e.to_string()))?;
    db.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| HarnessError(e.to_string()))?;
    let started = Instant::now();
    butler_platform::instance::request_stop(s.agent.pid().unwrap())
        .map_err(|e| HarnessError(e.to_string()))?;
    while s.agent.is_running() {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let exit_elapsed = started.elapsed();
    diagnostics::print_shutdown(&s);
    butler_e2e::assert_wall_clock_budget!(
        exit_elapsed,
        Duration::from_secs(8),
        "memory stop missed deadline"
    );
    assert!(s.agent.reap().unwrap().success());
    let logs = s.agent.logs();
    let requested = logs.find("phase=stop_requested ").unwrap();
    let stopped = logs
        .find("phase=memory_sync_stopped ")
        .expect("memory work outlived service stop");
    let drain = logs
        .find("phase=turn_drain edge=end")
        .or_else(|| logs.find("phase=deadline_cleanup:begin "))
        .expect("shutdown neither drained nor reached its deadline");
    assert!(requested < stopped && stopped < drain, "{logs}");
    assert!(
        !logs[..stopped].contains("phase=turn_drain edge=end"),
        "memory waited for turn storage"
    );
    db.execute_batch("ROLLBACK")
        .map_err(|e| HarnessError(e.to_string()))?;
    drop(db);
    s.finish().await
}
