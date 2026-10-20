//! Optional interleaved main/head measurement on the very same owner fixture.
use butler_e2e::e2e::{HarnessError, executable, scenario::Scenario};
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
    let installed = s.agent.launch.binary.clone();
    let head = s.sandbox.root.join("startup-head-agent");
    executable::copy(&installed, &head)?;
    // The shared seed intentionally leaves 100 turns for App retention. Settle
    // those with the existing helper before comparing identical persisted data.
    executable::copy(&PathBuf::from(&baseline), &installed)?;
    s.gw = s.agent.start_again().await?;
    crate::app_storage_scale::wait_retention_settled(s).await;
    crate::data_perf::assert_app(&s.sandbox.data)?;
    assert!(
        usage::embedding_children(s.agent.pid().unwrap())?.is_none_or(|workers| workers.is_empty())
    );
    s.agent.terminate().await?;
    let mut elapsed = 0;
    for round in 1..=5 {
        for (name, binary) in [("main", PathBuf::from(&baseline)), ("head", head.clone())] {
            // The host validates its executable against the installation root.
            // Swap only while stopped, publishing a closed executable handle.
            executable::copy(&binary, &installed)?;
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
