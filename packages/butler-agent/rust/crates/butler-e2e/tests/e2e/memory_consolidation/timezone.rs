use super::*;

#[tokio::test]
async fn nonexistent_time_runs_at_the_first_valid_minute_in_butlers_timezone()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, address) = setup("MEM-CONSOLIDATION-DST-GAP").await?;
    let saved =
        s.gw.patch(
            "/settings",
            json!({"timezone":"America/New_York","consolidation_time":"02:30"}),
        )
        .await?;
    assert_eq!(saved.status, 200, "{}", saved.text);
    s.agent.terminate().await?;
    s.agent
        .launch
        .set_env("BUTLER_E2E_APP_NOW", "2027-03-14T06:59:00.000Z");
    s.gw = s.agent.start_again().await?;
    settled(&address).await?;
    // D17 first catches up yesterday, then still honors today's DST gap boundary.
    completed_calls(&s, 1).await;
    assert_eq!(state(&s)["late"], true);
    assert_eq!(state(&s)["scheduledAt"], "2027-03-13T07:30:00.000Z");
    clock(&address, "2027-03-14T07:00:00.000Z").await?;
    completed_calls(&s, 2).await;
    assert_eq!(state(&s)["late"], false);
    assert_eq!(state(&s)["lastRunDate"], "2027-03-14");
    assert_eq!(calls(&s), 2);
    s.finish().await
}

#[tokio::test]
async fn repeated_local_time_runs_only_once() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, address) = setup("MEM-CONSOLIDATION-DST-FOLD").await?;
    assert_eq!(
        s.gw.patch(
            "/settings",
            json!({"timezone":"America/New_York","consolidation_time":"01:30"})
        )
        .await?
        .status,
        200
    );
    s.agent.terminate().await?;
    s.agent
        .launch
        .set_env("BUTLER_E2E_APP_NOW", "2026-11-01T05:29:00.000Z");
    s.gw = s.agent.start_again().await?;
    settled(&address).await?;
    // D17 catches up yesterday before today's first repeated wall-time occurrence.
    completed_calls(&s, 1).await;
    assert_eq!(state(&s)["late"], true);
    clock(&address, "2026-11-01T05:30:00.000Z").await?;
    completed_calls(&s, 2).await;
    assert_eq!(state(&s)["late"], false);
    let first = state(&s);
    s.agent.terminate().await?;
    s.agent
        .launch
        .set_env("BUTLER_E2E_APP_NOW", "2026-11-01T06:30:00.000Z");
    s.gw = s.agent.start_again().await?;
    settled(&address).await?;
    assert_eq!(calls(&s), 2);
    assert_eq!(state(&s), first);
    s.finish().await
}

#[tokio::test]
async fn a_time_moved_to_now_stays_deferred_across_restart() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, address) = setup("MEM-CONSOLIDATION-DEFER").await?;
    assert_eq!(
        s.gw.patch("/settings", json!({"consolidation_time":"03:59"}))
            .await?
            .status,
        200
    );
    s.restart().await?;
    settled(&address).await?;
    assert_eq!(calls(&s), 0);
    assert!(
        !s.sandbox
            .data
            .join("state/scheduler/consolidation-cycle.intent.json")
            .exists()
    );
    clock(&address, "2026-10-03T03:59:00.000Z").await?;
    terminal(&s, "scheduled", "complete").await?;
    assert_eq!(state(&s)["lastRunDate"], "2026-10-03");
    s.finish().await
}
