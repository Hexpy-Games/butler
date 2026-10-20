//! A stale cursor reconciles once and receives the following turn on the same stream.
use super::*;
use std::time::Duration;

#[tokio::test]
async fn cursor_zero_above_buffer_stays_open() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    replay_gap(140).await
}

#[tokio::test]
async fn cursor_zero_above_old_replay_limit_stays_open() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    replay_gap(210).await
}

async fn replay_gap(count: usize) -> Result<(), HarnessError> {
    let s = Setup::new("REPLAY-GAP")?
        .stub_cassette(cassette()?)
        .start()
        .await?;
    for i in 0..count {
        let reply =
            s.gw.post(
                "/sessions",
                json!({"kind":"chat", "title":format!("Gap {i}")}),
            )
            .await?;
        assert_eq!(reply.status, 201, "{}", reply.text);
    }
    let events = s.gw.events_since(0).await?;
    assert!(events.len() >= count);
    if count < 200 {
        assert!(events.len() <= 200, "exercise the old replay window");
    }
    eprintln!("cursor=0 durable_events={} requested={count}", events.len());
    let high_water = events.last().unwrap()["id"].clone();
    let client = LiveEvents::subscribe(&s.gw, 0).await?;
    let reconcile = client
        .wait_for(Duration::from_secs(15), |event| {
            event["type"] == "stream.reconcile_required"
        })
        .await?;
    assert_eq!(reconcile["payload"]["high_water_cursor"], high_water);
    client
        .wait_for(Duration::from_secs(15), |event| {
            event["type"] == "answer_blocks.snapshot"
        })
        .await?;
    assert!(
        !client.is_closed(),
        "gap reconciliation must keep the stream open"
    );
    let accepted = s.gw.say("general", PROMPT).await?;
    let turn = butler_e2e::e2e::scenario::accepted_turn_id(&accepted)?;
    let delivered = client
        .wait_for(Duration::from_secs(15), |event| {
            event["type"] == "message.updated"
                && event["payload"]["message"]["turn_id"] == turn
                && event["payload"]["message"]["status"] == "delivered"
        })
        .await?;
    assert_eq!(
        delivered["payload"]["message"]["text"],
        "Two methods are ready."
    );
    let mut spec = corrected();
    spec["blocks"][0]["media"] = json!("1:1");
    spec["blocks"][0]["items"][0]["title"] = json!("Method A");
    assert_eq!(
        delivered["payload"]["message"]["answer_blocks"][0]["spec"],
        spec
    );
    assert_eq!(
        client
            .snapshot()
            .iter()
            .filter(|event| event["type"] == "stream.reconcile_required")
            .count(),
        1
    );
    assert!(!client.is_closed());
    drop(client);
    s.finish().await
}
