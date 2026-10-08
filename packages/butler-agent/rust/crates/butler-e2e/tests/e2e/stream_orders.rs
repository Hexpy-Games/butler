//! Both observed Responses event orders must deliver the complete answer once.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use butler_e2e::e2e::{HarnessError, cassette::Cassette, gateway::turn_state, scenario::Setup};

async fn replay(name: &str, done_before_content: bool) -> Result<(), HarnessError> {
    let mut cassette = Cassette::load(name)?;
    if !done_before_content {
        // A max-effort recording may include an optional reasoning item.
        // Also exercise the observed stream without that item's boundaries.
        for exchange in &mut cassette.exchanges {
            exchange.response.chunks.retain(|chunk| {
                !chunk.text.lines().any(|line| {
                    line.strip_prefix("data:")
                        .and_then(|data| {
                            serde_json::from_str::<serde_json::Value>(data.trim()).ok()
                        })
                        .is_some_and(|event| event["item"]["type"] == "reasoning")
                })
            });
        }
    }
    let exchange = cassette
        .exchanges
        .iter()
        .find(|exchange| exchange.request.key.user_request == "Reply with exactly: memory check")
        .expect("plain-answer exchange");
    let fingerprint = butler_e2e::e2e::cassette::fingerprint(&exchange.response);
    let position = |kind: &str| {
        fingerprint
            .iter()
            .position(|entry| entry.starts_with(kind))
            .unwrap()
    };
    assert_eq!(
        position("response.output_item.done{") < position("response.content_part.added{"),
        done_before_content,
        "fixture must exercise the observed order"
    );
    let expected = exchange.response.output_text();
    assert!(!expected.is_empty());
    let prompt = exchange.request.key.user_request.clone();
    let s = Setup::new(&format!("STREAM-ORDER-{name}"))?
        .stub_cassette(cassette)
        .start()
        .await?;
    let (id, turn) = s.turn("general", &prompt).await?;
    assert_eq!(turn_state(&turn), "delivered");
    let messages = s.gw.messages("general").await?;
    let answers: Vec<_> = messages
        .iter()
        .filter(|message| message["role"] == "assistant" && message["turn_id"] == id)
        .filter_map(|message| message["text"].as_str())
        .collect();
    assert_eq!(
        answers,
        vec![expected.as_str()],
        "complete answer must be delivered exactly once"
    );
    s.finish().await
}

#[tokio::test]
async fn legacy_item_done_before_content_delivers_complete_answer() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    replay("MEM-03", true).await
}

#[tokio::test]
async fn current_item_done_after_content_delivers_complete_answer() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    // MEM-03 already records message completion after content. Removing its
    // optional reasoning boundaries above also covers the message-only stream.
    // LIVE-09 is a separately recorded live baseline, not a stub prerequisite.
    replay("MEM-03", false).await
}
