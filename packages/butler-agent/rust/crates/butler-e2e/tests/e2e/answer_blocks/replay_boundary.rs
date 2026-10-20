//! Exercise exact output occupancy through the public replay endpoint. Socket
//! backpressure cannot pin this queue: the HTTP server drains into TCP buffers.
//! Replaying a counted durable suffix queues it before the body is first polled.
use super::*;
use std::time::Duration;

#[tokio::test]
async fn replay_boundary_preserves_drafts_and_recovers_once() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut recording = cassette()?;
    recording.exchanges.remove(0);
    recording.exchanges[0].request.key.round.clear();
    recording.exchanges[1].request.key.round =
        vec!["function_call".into(), "function_call_output".into()];
    let s = Setup::new("REPLAY-DRAFT-BOUNDARY")?
        .stub_cassette(recording)
        .start()
        .await?;
    let gate = s.provider()?.hold_after_tool(PROMPT);
    let observer = LiveEvents::subscribe(&s.gw, 0).await?;
    let accepted = s.gw.say("general", PROMPT).await?;
    let turn = butler_e2e::e2e::scenario::accepted_turn_id(&accepted)?;
    observer
        .wait_for(Duration::from_secs(20), |event| {
            event["type"] == "answer_blocks.draft"
                && event["payload"]["ops"].as_array().is_some_and(|ops| {
                    ops.iter()
                        .any(|op| op["op"] == "end" && op["outcome"] == "accepted")
                })
        })
        .await?;
    // Session creation supplies real committed chunks without advancing the held turn.
    for i in 0..130 {
        let reply =
            s.gw.post(
                "/sessions",
                json!({"kind":"chat", "title":format!("Replay {i}")}),
            )
            .await?;
        assert_eq!(reply.status, 201, "{}", reply.text);
    }
    let events = s.gw.events_since(0).await?;
    assert!(events.len() >= 129);
    let high_water = events.last().unwrap()["id"].as_u64().unwrap();
    let reference = LiveEvents::subscribe(&s.gw, high_water).await?;
    let expected = reference
        .wait_for(Duration::from_secs(10), |event| {
            event["type"] == "answer_blocks.snapshot"
        })
        .await?;
    for index in [0, 1] {
        assert!(
            expected["payload"]["drafts"]
                .as_array()
                .unwrap()
                .iter()
                .any(|draft| {
                    draft["ops"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|op| op["op"] == "item" && op["index"] == index)
                }),
            "canonical draft must contain item {index}"
        );
    }
    let mut clients = vec![reference];
    let mut failures = Vec::new();
    for durable in [125, 126, 127, 128, 129] {
        let cursor = events[events.len() - durable - 1]["id"].as_u64().unwrap();
        let client = LiveEvents::subscribe(&s.gw, cursor).await?;
        let first = client
            .wait_for(Duration::from_secs(10), |event| {
                event["type"] == "answer_blocks.snapshot"
                    || event["type"] == "stream.reconcile_required"
            })
            .await?;
        let frames = client.snapshot();
        let reconciles = frames
            .iter()
            .filter(|event| event["type"] == "stream.reconcile_required")
            .count();
        eprintln!(
            "durable={durable} content_slots={} frames={} reconciles={reconciles} first={} closed={}",
            durable + 1,
            frames.len(),
            first["type"],
            client.is_closed()
        );
        if durable <= 127 && reconciles == 0 {
            assert!(!client.is_closed());
            assert_eq!(first["payload"], expected["payload"]);
            let replayed: Vec<_> = frames
                .iter()
                .filter(|event| event["id"].is_u64())
                .cloned()
                .collect();
            assert_eq!(replayed, events[events.len() - durable..]);
            clients.push(client);
        } else {
            if durable <= 127 {
                failures.push(format!(
                    "premature reconcile at {} content slots",
                    durable + 1
                ));
            }
            assert_eq!(reconciles, 1);
            let closed = tokio::time::timeout(Duration::from_secs(2), async {
                while !client.is_closed() {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .is_ok();
            eprintln!("durable={durable} overflow_stream_closed={closed}");
            if !closed {
                failures.push(format!(
                    "overflow did not reconnect at {} content slots",
                    durable + 1
                ));
            }
            assert_eq!(
                client
                    .snapshot()
                    .iter()
                    .filter(|event| event["type"] == "stream.reconcile_required")
                    .count(),
                1
            );
            assert_eq!(first["payload"]["high_water_cursor"], high_water);
            let recovered = LiveEvents::subscribe(&s.gw, high_water).await?;
            let snapshot = recovered
                .wait_for(Duration::from_secs(10), |event| {
                    event["type"] == "answer_blocks.snapshot"
                })
                .await?;
            assert_eq!(snapshot["payload"], expected["payload"]);
            // Reconcile refreshes canonical durable state; the suffix remains complete.
            assert_eq!(
                s.gw.events_since(cursor).await?,
                events[events.len() - durable..]
            );
            clients.push(recovered);
        }
    }
    gate.release();
    s.gw.wait_turn("general", &turn, &["delivered"], Duration::from_secs(20))
        .await?;
    for client in &clients {
        let final_event = client
            .wait_for(Duration::from_secs(10), |event| {
                event["type"] == "message.updated"
                    && event["payload"]["message"]["turn_id"] == turn
                    && event["payload"]["message"]["status"] == "delivered"
            })
            .await?;
        assert_eq!(
            final_event["payload"]["message"]["text"],
            "Two methods are ready."
        );
        let mut spec = corrected();
        spec["blocks"][0]["media"] = json!("1:1");
        spec["blocks"][0]["items"][0]["title"] = json!("Method A");
        assert_eq!(
            final_event["payload"]["message"]["answer_blocks"][0]["spec"],
            spec
        );
        assert!(!client.is_closed(), "recovery must stay connected");
        assert_eq!(
            client
                .snapshot()
                .iter()
                .filter(|event| event["type"] == "stream.reconcile_required")
                .count(),
            0
        );
    }
    drop((clients, observer));
    s.finish().await?;
    assert!(failures.is_empty(), "{}", failures.join("; "));
    Ok(())
}
