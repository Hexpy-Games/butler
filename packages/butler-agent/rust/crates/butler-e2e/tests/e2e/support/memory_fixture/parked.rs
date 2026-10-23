//! The memory consumer's own idle state, read from its sync trace. Scenarios
//! that wait on it start the agent with `BUTLER_MEMORY_SYNC_TRACE=1`.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "E2E assertions")]
use butler_e2e::e2e::scenario::Scenario;
use std::time::Duration;

const TRACE: &str = "[memory-sync-trace]";
const PARKED: &str = "[memory-sync-trace] park delay=None";

/// Waits until the current agent process's consumer has parked without a
/// deadline and has not polled since. It then has no work it can see, and
/// only a new change or notice wakes it; elapsed time is never evidence of
/// this. Call it after the state the scenario waits for (drained, settled),
/// so the park follows that work.
pub(crate) async fn wait_parked(s: &Scenario) {
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let logs = s.agent.current_logs().await.unwrap();
            let last = logs.lines().rfind(|line| line.contains(TRACE));
            if last.is_some_and(|line| line.ends_with(PARKED)) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("memory consumer did not finish its work and park without a deadline");
}
