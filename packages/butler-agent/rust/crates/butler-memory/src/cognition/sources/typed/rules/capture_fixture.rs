//! Stub-only scheduling barriers; all filesystem waits run off Tokio workers.
use super::{CognitionResult, RememberedRuleOwner, failure, failure_source};
use std::{
    path::Path,
    time::{Duration, Instant},
};

fn enabled() -> bool {
    std::env::var("BUTLER_E2E_TIER").as_deref() == Ok("stub")
        && std::env::var("BUTLER_E2E_RULE_CAPTURE_DRAIN_BARRIER").as_deref() == Ok("1")
}

impl RememberedRuleOwner {
    /// Keep the consumer from winning the capture before the inline busy barrier.
    pub(crate) async fn capture_drain_held(&self) -> bool {
        if !enabled() {
            return false;
        }
        let state = self.data_root.join("state");
        tokio::fs::try_exists(state.join("rule-capture-drain-arm"))
            .await
            .unwrap_or(false)
            && !tokio::fs::try_exists(state.join("rule-capture-drain-reached"))
                .await
                .unwrap_or(false)
    }
}

/// Called only inside the drain's spawn_blocking closure, before WORK is re-armed.
pub(super) fn force_busy(data: &Path) -> CognitionResult<bool> {
    let state = data.join("state");
    if !enabled()
        || !state
            .join("rule-capture-drain-arm")
            .try_exists()
            .map_err(failure_source)?
    {
        return Ok(false);
    }
    std::fs::write(state.join("rule-capture-drain-reached"), b"").map_err(failure_source)?;
    let deadline = Instant::now() + Duration::from_secs(90);
    wait_file(&state.join("rule-capture-drain-release"), deadline)?;
    std::fs::remove_file(state.join("rule-capture-drain-arm")).map_err(failure_source)?;
    Ok(true)
}

fn wait_file(path: &Path, deadline: Instant) -> CognitionResult<()> {
    while !path.try_exists().map_err(failure_source)? {
        if Instant::now() >= deadline {
            return Err(failure("rule_capture_drain_barrier_timeout"));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    Ok(())
}
