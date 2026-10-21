//! Restart the isolated process without preloading the embedding worker.
use butler_e2e::e2e::{HarnessError, scenario::Scenario};
use std::time::Instant;

pub(super) async fn start(s: &mut Scenario) -> Result<u128, HarnessError> {
    let started = Instant::now();
    s.gw = s.agent.start_again().await?;
    Ok(started.elapsed().as_millis())
}
