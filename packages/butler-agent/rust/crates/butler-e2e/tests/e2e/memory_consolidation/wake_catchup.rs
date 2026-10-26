//! SS12: wake notification interrupts the unchanged sixty-second fallback.
use super::*;

#[tokio::test]
async fn ss12_consolidation_wake_catches_up_once() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, address) = setup("SS12-CONSOLIDATION").await?;
    s.gw.patch("/settings", json!({"consolidation_time":"05:00"}))
        .await?;
    settled(&address).await?;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(calls(&s), 0);
    clock(&address, "2026-10-04T07:00:00.000Z").await?;
    let started = std::time::Instant::now();
    clock(&address, "wake").await?;
    // We just entered a 60 s wait slice. Completion within 5 s proves the wake arm.
    tokio::time::timeout(
        Duration::from_secs(5),
        terminal(&s, "scheduled", "complete"),
    )
    .await
    .expect("wake must interrupt the wait")?;
    eprintln!(
        "SS12 consolidation wake_to_complete_ms={}",
        started.elapsed().as_millis()
    );
    assert_eq!(calls(&s), 1);
    assert_eq!(state(&s)["late"], true);
    assert_eq!(state(&s)["scheduledAt"], "2026-10-04T05:00:00.000Z");
    assert_eq!(
        s.gw.get("/memory/consolidation").await?.data()["last_run"]["late"],
        true
    );
    clock(&address, "wake").await?;
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_eq!(calls(&s), 1);
    s.finish().await
}
