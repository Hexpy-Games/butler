//! Concurrent cold monitor and session-view latency evidence on history data.
use super::*;

#[tokio::test]
async fn usage_cold_monitor_concurrent_session_view() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("usage-concurrent-reads")?;
    let mut expected = write_usage_log(&setup.sandbox.data, chrono_now())?;
    write_transcripts(&setup.sandbox.data, &mut expected)?;
    let s = setup.start().await?;
    let started = Instant::now();
    let (monitor, session) = tokio::join!(
        async {
            let reply = timed(&s.gw, "/usage-monitor").await?;
            Ok::<_, HarnessError>((started.elapsed(), reply.1))
        },
        async {
            let reply = timed(&s.gw, "/session-view?session_id=general").await?;
            Ok::<_, HarnessError>((started.elapsed(), reply.1))
        },
    );
    let (monitor_time, monitor) = monitor?;
    let (session_time, session) = session?;
    // Request scheduling is not a barrier: report completion order rather than
    // asserting a race. Both complete responses must still be correct.
    eprintln!(
        "usage lock: session-view={session_time:?} cold-monitor={monitor_time:?} session-first={}",
        session_time < monitor_time
    );
    assert_eq!(monitor["model"]["requestCount"], ROWS);
    assert_eq!(monitor["tools"]["calls"], expected.tool_calls);
    assert_eq!(monitor["tools"]["failures"], expected.tool_failures);
    super::super::usage_timeline::assert_timeline(&monitor);
    for (key, total) in [
        ("request_count", SESSION_ROWS),
        ("input_tokens", SESSION_ROWS * 1000),
        ("cached_input_tokens", SESSION_ROWS * 400),
        ("output_tokens", SESSION_ROWS * 200),
    ] {
        assert_eq!(session["usage"][key], total, "{key}");
    }
    s.finish().await
}
