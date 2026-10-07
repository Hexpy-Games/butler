//! Both observed Responses event orders must deliver the complete answer once.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use butler_e2e::e2e::{HarnessError, cassette::Cassette, gateway::turn_state, scenario::Setup};

async fn replay(name: &str, done_before_content: bool) -> Result<(), HarnessError> {
    let cassette = Cassette::load(name)?;
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
    replay("LIVE-09", false).await
}
