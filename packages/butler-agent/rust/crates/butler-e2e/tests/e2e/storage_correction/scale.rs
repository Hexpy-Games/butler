//! Sparse startup reclamation over wide owner-scale history, through the real process.
use super::offline;
use butler_e2e::e2e::{HarnessError, provider::Script, scenario::Setup};
use rusqlite::Connection;
use std::{
    path::Path,
    time::{Duration, Instant},
};
mod plans;
mod seed;

#[tokio::test]
async fn storage_correction_owner_scale_startups() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        std::env::var("BUTLER_E2E_OWNER_SCALE").as_deref() == Ok("1"),
        "requires 800 chats / 300,000 wide turns on disk"
    );
    let _serial = super::SERIAL.lock().await;
    let mut s = Setup::new("CORR-STARTUP-SCALE")?
        .env("BUTLER_E2E_STARTUP_TRACE", "1")
        .synthetic(Script {
            rounds: 0,
            path_for: Box::new(|_| String::new()),
            final_text: "Settled.".into(),
        })
        .start()
        .await?;
    s.agent.terminate().await?;
    let data = s.sandbox.data.clone();
    offline(&data, seed::seed).await?;
    let path = data.join("agent-runtime/btcc.sqlite");
    offline(&path, plans::check).await?;
    for (generation, kind) in [
        (2, "upgrade"),
        (3, "after-three-turns"),
        (4, "no-new-turns"),
    ] {
        let identities = offline(&path, seed::identities).await?;
        offline(&path, seed::cold).await?;
        let started = Instant::now();
        s.gw = s.agent.start_again().await?;
        let ready = started.elapsed();
        let log = std::fs::read_to_string(s.sandbox.logs.join(format!("agent-{generation}.log")))?;
        let correction = correction_duration(&log);
        eprintln!(
            "RECLAIM-SCALE kind={kind} ready_ms={:.3} correction_ms={:.3}",
            ready.as_secs_f64() * 1000.0,
            correction.as_secs_f64() * 1000.0
        );
        for line in log
            .lines()
            .filter(|line| line.contains("[btcc-startup]") || line.contains("[native-startup]"))
        {
            eprintln!("RECLAIM-SCALE {kind} {line}");
        }
        offline(&path, seed::assert_complete).await?;
        assert_eq!(offline(&path, seed::identities).await?, identities);
        if generation == 4 {
            assert!(!log.contains("step=reclaim_chunk"));
        } else {
            assert!(log.contains("step=reclaim_chunk turns=3"));
        }
        // Sparse work must stay below the existing 5 s ordinary-start budget.
        // Enforced only in PERF mode, allowing the same fixture to profile the baseline.
        butler_e2e::assert_wall_clock_budget!(correction, Duration::from_secs(2), kind);
        butler_e2e::assert_wall_clock_budget!(ready, Duration::from_secs(5), kind);
        if generation == 2 {
            for _ in 0..3 {
                let (_, turn) = s.turn("general", "Please acknowledge.").await?;
                assert_eq!(turn["state"], "delivered");
            }
            offline(&path, |path| {
                let db = Connection::open(path)?;
                assert_eq!(
                    db.query_row("SELECT count(*) FROM agent_acceptance_reclaims", [], |r| {
                        r.get::<_, u64>(0)
                    })?,
                    3
                );
                Ok(())
            })
            .await?;
        }
        s.agent.terminate().await?;
    }
    s.finish().await
}

fn correction_duration(log: &str) -> Duration {
    let line = log
        .lines()
        .find(|line| line.contains("phase=storage_correction outcome="))
        .expect("correction outcome trace");
    let micros = line
        .split_whitespace()
        .find_map(|part| part.strip_prefix("duration_us="))
        .expect("duration")
        .parse()
        .expect("microseconds");
    Duration::from_micros(micros)
}
