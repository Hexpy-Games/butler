//! SS12: wake notification interrupts the unchanged sixty-second fallback.
use super::*;

#[tokio::test]
async fn ss12_consolidation_wake_catches_up_once() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    fresh_start_after_due_waits_for_next_occurrence().await?;
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

async fn fresh_start_after_due_waits_for_next_occurrence() -> Result<(), HarnessError> {
    use butler_e2e::e2e::{fixtures, scenario::Fixture};
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    let address = listener.local_addr()?.to_string();
    drop(listener);
    let mut cassette = Cassette::load("TOOL-01")?;
    cassette.exchanges.clear();
    let setup = Setup::new("CONSOLIDATION-FRESH-AFTER-DUE")?
        .fixture(Fixture::Empty)
        .stub_cassette(cassette)
        .env("BUTLER_E2E_APP_NOW", "2026-10-02T07:00:00.000Z")
        .env("BUTLER_E2E_APP_CLOCK_ADDRESS", &address);
    fixtures::ready(
        &setup.sandbox.data,
        "openai/gpt-6-sol",
        "2026-10-02T07:00:00Z",
    )?;
    std::fs::remove_file(
        setup
            .sandbox
            .data
            .join("state/scheduler/consolidation-cycle.json"),
    )?;
    super::super::memory_fixture::initialize_empty(&setup.sandbox.data)?;
    let mut s = setup.start().await?;
    s.provider()?.set_chat_responder(briefing);
    s.select_model(&s.model).await?;
    settled(&address).await?;
    tokio::time::timeout(Duration::from_secs(90), async {
        while state(&s)["armedAtMs"].is_null() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("fresh schedule durably armed");
    let armed = state(&s);
    assert_eq!(
        armed,
        json!({"armedAtMs":chrono::DateTime::parse_from_rfc3339("2026-10-02T07:00:00Z").unwrap().timestamp_millis()})
    );
    assert_eq!(calls(&s), 0, "no occurrence predating the first arm");
    assert!(s.gw.get("/memory/consolidation").await?.data()["last_run"].is_null());
    s.restart().await?;
    settled(&address).await?;
    assert_eq!(state(&s), armed, "restart must preserve the original arm");
    assert_eq!(calls(&s), 0);
    clock(&address, "2026-10-03T04:00:00.000Z").await?;
    clock(&address, "wake").await?;
    terminal(&s, "scheduled", "complete").await?;
    assert_eq!(calls(&s), 1);
    assert_eq!(state(&s)["late"], false);
    assert_eq!(state(&s)["scheduledAt"], "2026-10-03T04:00:00.000Z");
    assert_eq!(state(&s)["armedAtMs"], armed["armedAtMs"]);
    s.finish().await
}
