//! Release-only PERF-IDLE: bounded idle reads and memory at owner scale.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use super::memory_fixture;

use butler_e2e::e2e::{
    HarnessError,
    events::LiveEvents,
    scenario::{Scenario, Setup},
};
use butler_platform::process_control::usage as process_usage;
use butler_platform::sqlite;
use std::time::Duration;

use super::app_storage_scale::seed as app_seed;
#[path = "idle_resources/seed.rs"]
mod seed;
#[path = "idle_resources/transcripts.rs"]
mod transcripts;
#[path = "idle_resources/writes.rs"]
mod writes;

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
    let setup = Setup::new("PERF-IDLE")?
        .env("BUTLER_E2E_TIER", "stub")
        .env("BUTLER_E2E_IDLE_PROBE", "1")
        .cassette("USE-02")
        .replay_only()
        .quota_polling();
    memory_fixture::initialize_empty(&setup.sandbox.data)?;
    let mut s = setup.start().await?;
    s.agent.terminate().await?;
    let app = s.sandbox.data.join("app-server/butler-client.sqlite");
    app_seed::seed_owner_scale(&sqlite::open(&app).unwrap(), 3_000);
    super::storage_concurrency_support::seed(&app);
    let expected = seed::owner_scale(&s.sandbox.data)?;
    transcripts::seed(&s.sandbox.data)?;
    eprintln!(
        "PERF-IDLE fixture app_bytes={} btcc_bytes={} canonical_bytes={}",
        std::fs::metadata(&app)?.len(),
        std::fs::metadata(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?.len(),
        std::fs::metadata(s.sandbox.data.join("runtime/conversation-store.sqlite"))?.len()
    );
    s.gw = s.agent.start_again().await?;
    let live = connect_and_refresh(&s).await?;
    // Keep the existing startup grace, then prove committed memory readiness.
    tokio::time::sleep(Duration::from_secs(120)).await;
    memory_fixture::settle(&s.sandbox.data).await?;
    transcripts::assert_sizes(&s.sandbox.data)?;
    seed::assert_complete(&s.sandbox.data, &expected)?;
    let mut writes = writes::Watch::open(&s.sandbox.data)?;
    let served = s.provider()?.served();
    let opens = transcript_opens(&s).await?;
    assert!(
        opens > 0,
        "source-open instrumentation must observe startup reads"
    );
    let samples = measure(&s, &expected).await?;
    let final_opens = transcript_opens(&s).await?;
    eprintln!(
        "PERF-IDLE transcript_opens={} quota_requests={} elapsed_ms={}",
        final_opens - opens,
        s.provider()?.served() - served,
        samples.elapsed.as_millis()
    );
    writes.assert_unchanged();
    assert_eq!(
        final_opens, opens,
        "transcripts repeatedly opened during idle"
    );
    assert_eq!(s.provider()?.served(), served, "provider polled while idle");
    assert_samples(&samples);
    seed::assert_complete(&s.sandbox.data, &expected)?;
    transcripts::assert_sizes(&s.sandbox.data)?;
    transcripts::assert_append_wakes(&s).await?;
    drop(live);
    s.finish().await
}

async fn transcript_opens(s: &Scenario) -> Result<u64, HarnessError> {
    let reply = s.gw.get("/health").await?;
    Ok(reply.data()["transcript_read_opens"]
        .as_u64()
        .expect("enabled source-open probe"))
}

async fn connect_and_refresh(s: &Scenario) -> Result<LiveEvents, HarnessError> {
    let db = sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    let cursor = db.query_row("SELECT COALESCE(MAX(id),0) FROM events", [], |row| {
        row.get(0)
    })?;
    drop(db);
    let live = LiveEvents::subscribe(&s.gw, cursor).await?;
    let reply =
        s.gw.get("/provider-quota?provider_id=openai&refresh=1")
            .await?;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.data()["available"], true);
    live.wait_for(Duration::from_secs(10), |event| {
        event["type"] == "provider_quota_updated" && event["payload"]["provider_id"] == "openai"
    })
    .await?;
    Ok(live)
}

struct Samples {
    elapsed: Duration,
    windows: Vec<(process_usage::ProcessUsage, process_usage::ProcessUsage)>,
}

async fn measure(s: &Scenario, expected: &seed::Expected) -> Result<Samples, HarnessError> {
    let pid = s.agent.pid().unwrap();
    let mut before = process_usage::sample(pid)?.unwrap();
    let started = std::time::Instant::now();
    let mut windows = Vec::new();
    eprintln!("PERF-IDLE start load={:?}", process_usage::load_average()?);
    // Collect the entire ten-minute interval before applying every unchanged
    // per-minute budget, so a failure also retains its complete attribution.
    for window in 0..10 {
        tokio::time::sleep(WINDOW).await;
        let after = process_usage::sample(pid)?.unwrap();
        let chars = after.read_chars.zip(before.read_chars).map(|(a, b)| a - b);
        let reads = after.read_bytes - before.read_bytes;
        let writes = after.write_bytes - before.write_bytes;
        let opens = transcript_opens(s).await?;
        eprintln!(
            "PERF-IDLE window={window} rss={} pss={:?} footprint={:?} rchar={chars:?} read_bytes={reads} write_bytes={writes} transcript_opens={opens} quota_served={} load={:?}",
            after.resident_bytes,
            after.proportional_bytes,
            after.footprint_bytes,
            s.provider()?.served(),
            process_usage::load_average()?
        );
        seed::assert_complete(&s.sandbox.data, expected)?;
        windows.push((before, after));
        before = after;
    }
    Ok(Samples {
        elapsed: started.elapsed(),
        windows,
    })
}

fn assert_samples(samples: &Samples) {
    assert!(samples.elapsed >= Duration::from_secs(600));
    for (before, after) in &samples.windows {
        let chars = after.read_chars.zip(before.read_chars).map(|(a, b)| a - b);
        let reads = after.read_bytes - before.read_bytes;
        assert!(
            after.footprint_bytes.unwrap_or(after.resident_bytes) < MEMORY_BUDGET,
            "idle memory: {after:?}"
        );
        assert!(
            chars.is_none_or(|chars| chars < READ_BUDGET) && reads < READ_BUDGET,
            "idle reads: rchar={chars:?} read_bytes={reads}"
        );
        assert_eq!(
            after.write_bytes, before.write_bytes,
            "physical writes during idle"
        );
        assert!(
            after
                .write_chars
                .zip(before.write_chars)
                .is_none_or(|(a, b)| a == b),
            "buffered writes during idle"
        );
    }
}
