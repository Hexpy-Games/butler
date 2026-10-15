use super::{Duration, HarnessError, Instant, Scenario, runs, scheduler_errors};

pub(super) async fn scheduler_reads(s: &Scenario) -> Result<u64, HarnessError> {
    let reply =
        s.gw.get("/automations/_test/scheduler-next-due-reads")
            .await?;
    Ok(reply.data().as_u64().unwrap())
}

pub(super) async fn scheduler_diagnostics(s: &Scenario) -> Result<(), HarnessError> {
    eprintln!(
        "scheduler reads={} dispatch_attempts={} scheduler_errors={} runs={:?}",
        scheduler_reads(s).await?,
        scheduler_attempts(s).await?,
        scheduler_errors(&s.sandbox.data).await?,
        runs(s).await?
    );
    Ok(())
}

pub(super) async fn wait_scheduler_reads(
    s: &Scenario,
    expected: u64,
) -> Result<Instant, HarnessError> {
    let result = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if scheduler_reads(s).await? >= expected {
                return Ok::<_, HarnessError>(Instant::now());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap_or_else(|_| {
        Err(HarnessError(
            "scheduler did not retry the failed dispatch after wake".into(),
        ))
    });
    if result.is_err() {
        scheduler_diagnostics(s).await?;
    }
    result
}

pub(super) async fn scheduler_attempts(s: &Scenario) -> Result<u64, HarnessError> {
    let reply =
        s.gw.get("/automations/_test/scheduler-dispatch-attempts")
            .await?;
    Ok(reply.data().as_u64().unwrap())
}

pub(super) async fn wait_scheduler_attempt(
    s: &Scenario,
    before: u64,
) -> Result<Instant, HarnessError> {
    let result = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let completed = scheduler_attempts(s).await?;
            let reads = scheduler_reads(s).await?;
            // A notified attempt is followed by a lookup and another due attempt.
            // The due attempt's completed count stays ahead of its lookup during
            // failure backoff; the notified completion alone can race that attempt.
            if completed > before && completed > reads {
                eprintln!(
                    "SCHED-14 backoff observed completed_dispatches={completed} indexed_reads={reads} utc_us={}",
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_micros()
                );
                return Ok::<_, HarnessError>(Instant::now());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .map_err(|_| HarnessError("scheduler did not complete dispatch after wake".into()))
    .and_then(|result| result);
    if result.is_err() {
        scheduler_diagnostics(s).await?;
    }
    result
}
