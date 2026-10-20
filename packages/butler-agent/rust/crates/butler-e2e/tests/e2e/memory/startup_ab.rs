//! Optional interleaved main/head measurement on the very same owner fixture.
use butler_e2e::e2e::{HarnessError, scenario::Scenario};
use butler_platform::process_control::usage;
use std::{path::PathBuf, time::Instant};

pub(super) async fn start(
    s: &mut Scenario,
    transcripts: &crate::transcript_scale::Expected,
) -> Result<u128, HarnessError> {
    let Some(baseline) = std::env::var_os("BUTLER_E2E_STARTUP_BASELINE") else {
        let started = Instant::now();
        s.gw = s.agent.start_again().await?;
        return Ok(started.elapsed().as_millis());
    };
    let head = s.agent.launch.binary.clone();
    let mut elapsed = 0;
    for round in 1..=5 {
        for (name, binary) in [("main", PathBuf::from(&baseline)), ("head", head.clone())] {
            s.agent.launch.binary = binary;
            let started = Instant::now();
            s.gw = s.agent.start_again().await?;
            elapsed = started.elapsed().as_millis();
            let logs = s.agent.current_logs().await?;
            eprintln!("STARTUP-AB round={round} build={name} ready_ms={elapsed}");
            for line in logs
                .lines()
                .filter(|line| line.contains("[native-startup]") || line.contains("startup.phase"))
            {
                eprintln!("STARTUP-AB round={round} build={name} {line}");
            }
            assert!(
                usage::embedding_children(s.agent.pid().unwrap())?
                    .is_none_or(|workers| workers.is_empty()),
                "startup must stay cold in both builds"
            );
            // Outside the timed window, require the same complete current data
            // after every start, rather than comparing readiness alone.
            crate::data_perf::assert_app(&s.sandbox.data)?;
            crate::btcc_scale::assert_complete(&s.sandbox.data)?;
            crate::transcript_scale::assert_complete(&s.sandbox.data, transcripts)?;
            if round != 5 || name != "head" {
                s.agent.terminate().await?;
            }
        }
    }
    Ok(elapsed)
}
