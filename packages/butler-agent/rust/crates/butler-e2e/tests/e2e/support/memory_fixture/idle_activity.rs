//! Idle activity that recurs, as opposed to one settling event. An idle window
//! is split into sub-windows; activity may appear once (one event can straddle
//! a sub-window boundary) but must not persist or come back later.
use butler_platform::process_control::usage::{self, ProcessUsage};
use std::time::Duration;

/// Samples `pid` at the start and at the end of each of `parts` equal
/// sub-windows of `window`. The total observation stays `window`; `None`
/// where the platform has no process counters.
pub(crate) async fn sample_window(
    pid: u32,
    window: Duration,
    parts: u32,
) -> std::io::Result<Option<Vec<ProcessUsage>>> {
    let started = tokio::time::Instant::now();
    let mut samples = vec![usage::sample(pid)?];
    for part in 1..=parts {
        tokio::time::sleep_until(started + window * part / parts).await;
        samples.push(usage::sample(pid)?);
    }
    Ok(samples.into_iter().collect())
}

/// Per-sub-window deltas of one counter.
pub(crate) fn deltas(samples: &[ProcessUsage], counter: fn(&ProcessUsage) -> u64) -> Vec<u64> {
    samples
        .windows(2)
        .map(|pair| counter(&pair[1]).saturating_sub(counter(&pair[0])))
        .collect()
}

/// Recorded in every tier; enforced only in the isolated perf job
/// (`BUTLER_E2E_PERF=1`), like `assert_wall_clock_budget!`.
pub(crate) fn assert_no_recurring_activity(label: &str, deltas: &[u64]) {
    let active: Vec<usize> = (0..deltas.len()).filter(|&i| deltas[i] > 0).collect();
    let once = active.len() <= 2 && active.windows(2).all(|pair| pair[1] == pair[0] + 1);
    let enforce = std::env::var("BUTLER_E2E_PERF").as_deref() == Ok("1");
    eprintln!("idle activity: {label} sub_window_deltas={deltas:?} once={once} enforced={enforce}");
    if enforce {
        assert!(once, "{label} recurred during idle: {deltas:?}");
    }
}
