//! Bounded monotonic waits for deadlines measured by a wall clock.
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Re-read a wall clock at least this often while waiting for a deadline.
pub const MAX_WAIT_SLICE: Duration = Duration::from_secs(60);

/// Current Unix milliseconds, clamped to the supported integer range.
pub fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX)
        })
}

/// Wait until a deadline, re-reading the supplied clock after each slice.
/// This does no I/O and can be cancelled by dropping the future.
pub async fn wait_until(deadline_ms: i64, now: impl Fn() -> i64) {
    loop {
        let remaining = deadline_ms.saturating_sub(now());
        if remaining <= 0 {
            return;
        }
        let delay = Duration::from_millis(u64::try_from(remaining).unwrap_or_default());
        tokio::time::sleep(delay.min(MAX_WAIT_SLICE)).await;
    }
}

/// Wait a duration of wall-clock time without retaining a suspend-blind sleep.
pub async fn wait_for(delay: Duration) {
    let millis = i64::try_from(delay.as_millis()).unwrap_or(i64::MAX);
    wait_until(now_millis().saturating_add(millis), now_millis).await;
}
