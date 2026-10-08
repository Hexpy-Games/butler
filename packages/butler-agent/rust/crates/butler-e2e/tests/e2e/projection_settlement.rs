//! Durable terminal settlement wakes the UI independently of filesystem events.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    events::LiveEvents,
    gateway::turn_state,
    scenario::{Setup, accepted_turn_id},
};
use std::time::{Duration, Instant};

#[tokio::test]
async fn terminal_settlement_delivers_without_filesystem_notifications() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let cassette = Cassette::load("Q-02")?;
    let prompt = cassette.exchanges[0].request.key.user_request.clone();
    let expected = cassette.exchanges[0].response.output_text();
    assert_ne!(expected, "");
    let s = Setup::new("TURN-SETTLEMENT-WAKE")?
        .stub_cassette(cassette)
        .env("BUTLER_E2E_TIER", "stub")
        .env("BUTLER_E2E_DISABLE_PROJECTION_WATCH", "1")
        .env("BUTLER_E2E_HOLD_SETTLEMENT", "1")
        .start()
        .await?;
    let live = LiveEvents::subscribe(&s.gw, 0).await?;
    let id = accepted_turn_id(&s.gw.say("general", &prompt).await?)?;
    let queue = s.sandbox.data.join("runtime/inbound-events");
    let database = s.sandbox.data.join("app-server/butler-client.sqlite");
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let db = rusqlite::Connection::open_with_flags(
            &database,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(|error| butler_e2e::e2e::harness_error(error.to_string()))?;
        let staged: i64 = db.query_row(
            "SELECT count(*) FROM app_transport_projection_staged_outbounds WHERE state='deferred_final'",
            [], |row| row.get(0))
            .map_err(|error| butler_e2e::e2e::harness_error(error.to_string()))?;
        if queue.join("e2e-settlement-waiting").exists() && staged == 1 {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "final was not staged before settlement: {staged}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let before = s.gw.turn("general", &id).await?.unwrap();
    assert_eq!(turn_state(&before), "thinking", "{before}");
    tokio::fs::write(queue.join("e2e-settlement-release"), b"release").await?;
    // Observe the UI event directly: a foreground turn GET refreshes projection
    // and would mask a missing completion wake.
    live.wait_for(Duration::from_secs(15), |event| {
        event["type"] == "turn.state_changed"
            && event["payload"]["turn"]["id"] == id
            && event["payload"]["turn"]["state"] == "delivered"
    })
    .await?;
    let terminal = s.gw.turn("general", &id).await?.unwrap();
    assert_eq!(turn_state(&terminal), "delivered", "{terminal}");
    let messages = s.gw.messages("general").await?;
    let answers: Vec<_> = messages
        .iter()
        .filter(|m| m["turn_id"] == id && m["role"] == "assistant")
        .collect();
    assert_eq!(answers.len(), 1, "{messages:?}");
    assert_eq!(answers[0]["text"], expected);
    s.finish().await
}
