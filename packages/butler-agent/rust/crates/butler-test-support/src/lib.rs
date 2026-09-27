//! Test-only helpers shared by every Butler crate (dev-dependency only).
//!
//! [`eventually`] bounds waits on conditions that another task must reach.

use std::time::Duration;

/// Upper bound for a condition that another task is expected to reach promptly.
const DEADLINE: Duration = Duration::from_secs(10);

/// Waits until `condition` holds, yielding to other tasks between checks.
///
/// Replaces unbounded `while !condition { yield_now().await }` spins and
/// sleep-then-assert sequences: a regression fails with `what` instead of hanging.
pub async fn eventually(what: &str, mut condition: impl FnMut() -> bool) {
    let wait = async {
        while !condition() {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    };
    assert!(
        tokio::time::timeout(DEADLINE, wait).await.is_ok(),
        "timed out waiting for {what}"
    );
}
