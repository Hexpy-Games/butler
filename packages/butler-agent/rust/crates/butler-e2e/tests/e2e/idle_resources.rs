//! Release-only PERF-IDLE: bounded idle reads and memory at owner scale.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use butler_e2e::e2e::{HarnessError, scenario::Setup};
use butler_platform::process_control::usage as process_usage;
use rusqlite::Connection;
use std::time::Duration;

use super::app_storage_seed as app_seed;
#[path = "idle_resources/seed.rs"]
mod seed;

const WINDOW: Duration = Duration::from_secs(60);
const MEMORY_BUDGET: u64 = 100_000_000;
const READ_BUDGET: u64 = 1_000_000;

#[tokio::test]
async fn perf_idle_owner_scale_reads_and_footprint() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        std::env::var("BUTLER_E2E_TIER").as_deref() == Ok("perf"),
        "PERF-IDLE requires BUTLER_E2E_TIER=perf and a release BUTLER_E2E_BIN"
    );
    butler_e2e::skip_unless!(
        process_usage::sample(std::process::id())?.is_some(),
        "process resource counters unavailable"
    );
    let mut s = Setup::new("PERF-IDLE")?.start().await?;
    let initialized = s
        .agent
        .cli_async(&[
            "cognition",
            "memory",
            "rebuild",
            "initialize-empty",
            "--json",
        ])
        .await?
        .json()?;
    assert_eq!(initialized["ok"], true, "{initialized}");
    s.agent.terminate().await?;
    let app = s.sandbox.data.join("app-server/butler-client.sqlite");
    app_seed::seed_owner_scale(&Connection::open(&app).unwrap(), 3_000);
    let expected = seed::owner_scale(&s.sandbox.data)?;
    s.gw = s.agent.start_again().await?;
    let pid = s.agent.pid().unwrap();
    eprintln!("PERF-IDLE pid={pid}");
    // Startup retention and the first source sweep finish before the samples.
    tokio::time::sleep(Duration::from_secs(120)).await;
    let mut before = process_usage::sample(pid)?.unwrap();
    for window in 0..3 {
        tokio::time::sleep(WINDOW).await;
        let after = process_usage::sample(pid)?.unwrap();
        let chars = after.read_chars.zip(before.read_chars).map(|(a, b)| a - b);
        let reads = after.read_bytes - before.read_bytes;
        eprintln!(
            "PERF-IDLE window={window} rss={} pss={:?} footprint={:?} rchar={chars:?} read_bytes={reads}",
            after.resident_bytes, after.proportional_bytes, after.footprint_bytes
        );
        assert!(
            after.footprint_bytes.unwrap_or(after.resident_bytes) < MEMORY_BUDGET,
            "idle memory: {after:?}"
        );
        assert!(
            chars.is_none_or(|chars| chars < READ_BUDGET) && reads < READ_BUDGET,
            "idle reads: rchar={chars:?} read_bytes={reads}"
        );
        seed::assert_complete(&s.sandbox.data, &expected)?;
        before = after;
    }
    s.finish().await
}
