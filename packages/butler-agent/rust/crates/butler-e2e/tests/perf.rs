//! P. Performance (PERF-01): what the runtime spends per model round.
//!
//! The model is scripted, so the time between the end of one reply and the
//! next request is the product's own: tool run, journal, context projection,
//! serialization and admission. The context grows by one file per round.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::fmt::Write;
use std::fs;
use std::time::Duration;

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::gateway::turn_state;
use butler_e2e::e2e::provider::{Script, round_overheads};
use butler_e2e::e2e::scenario::{Setup, accepted_turn_id};

const ROUNDS: usize = 60;
const FILE_BYTES: usize = 20_000;

/// A file of words that tokenize like prose, distinct per `seed`.
fn prose(seed: usize) -> String {
    const WORDS: [&str; 16] = [
        "context", "window", "request", "provider", "message", "history", "round", "budget",
        "token", "runtime", "session", "digest", "surface", "result", "worker", "cache",
    ];
    let mut state = seed as u64 * 2_654_435_761 + 1;
    let mut text = String::with_capacity(FILE_BYTES + 16);
    while text.len() < FILE_BYTES {
        state = state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        let word = WORDS[(state >> 33) as usize % WORDS.len()];
        let _ = write!(text, "{word}{} ", (state >> 20) % 97);
        if (state >> 50).is_multiple_of(12) {
            text.push('\n');
        }
    }
    text
}

/// The `percent`th percentile of `sorted` (nearest rank).
fn percentile(sorted: &[Duration], percent: usize) -> Duration {
    let index = (sorted.len() * percent)
        .div_ceil(100)
        .clamp(1, sorted.len());
    sorted[index - 1]
}

/// PERF-01 — With 1 MB of history, a round costs the runtime a small,
/// history-independent time: it works on what the round added.
///
/// Ignored until the turn hot-path fixes land: on the unfixed runtime the
/// scenario does not finish (see the PR notes), so it cannot gate CI yet.
/// Run it with `BUTLER_E2E_TIER=stub cargo test -p butler-e2e --test perf -- --ignored`.
#[ignore = "budget applies once the turn hot-path fixes land"]
#[tokio::test]
async fn perf_01_round_overhead_at_large_context() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("PERF-01")?.synthetic(Script {
        rounds: ROUNDS,
        path_for: Box::new(|round| format!("perf-{round}.txt")),
        final_text: "All files read.".into(),
    });
    for round in 0..ROUNDS {
        fs::write(
            setup.sandbox.data.join(format!("perf-{round}.txt")),
            prose(round),
        )?;
    }
    let s = setup.start().await?;
    let accepted =
        s.gw.say(
            "general",
            "Read every perf file in your workspace, one per step.",
        )
        .await?;
    let turn_id = accepted_turn_id(&accepted)?;
    let waited =
        s.gw.wait_terminal("general", &turn_id, Duration::from_secs(600))
            .await;
    // Report what the rounds cost even when the turn does not finish.
    let timings = s.provider()?.timings();
    let overheads = round_overheads(&timings);
    let millis = |value: Duration| value.as_secs_f64() * 1e3;
    let line = overheads
        .iter()
        .map(|value| format!("{:.1}", millis(*value)))
        .collect::<Vec<_>>()
        .join(" ");
    eprintln!(
        "PERF-01 {} requests, per-round overhead ms: {line}",
        timings.len()
    );
    let turn = waited?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    assert_eq!(
        timings.len(),
        ROUNDS + 1,
        "one request per round plus the answer"
    );
    let late = &overheads[overheads.len() - 10..];
    let mut sorted = late.to_vec();
    sorted.sort();
    let p95 = percentile(&sorted, 95);
    let bytes = timings.last().map_or(0, |timing| timing.request_bytes);
    eprintln!(
        "PERF-01 last request {bytes} bytes; last-10 rounds p50 {:.1} ms p95 {:.1} ms",
        millis(percentile(&sorted, 50)),
        millis(p95)
    );
    assert!(bytes > 1_000_000, "the context did not reach 1 MB: {bytes}");
    assert!(
        p95 < Duration::from_millis(20),
        "p95 per-round overhead at 1 MB of context is {:.1} ms (budget 20 ms)",
        millis(p95)
    );
    s.finish().await
}
