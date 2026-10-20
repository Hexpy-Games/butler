//! Stream-shape fingerprint pinned against a committed replay cassette.
use std::collections::BTreeSet;

use butler_e2e::e2e::{HarnessError, cassette, harness_error};

const PROMPT: &str = "Reply with exactly: memory check";

// Reasoning items are optional, and complete before the message starts. Keep
// every event/key schema, but compare the content timeline independently of
// those optional item boundaries. Never erase a message completion's position.
fn shape(
    response: &cassette::ResponseRecord,
) -> Result<(BTreeSet<String>, Vec<String>), HarnessError> {
    let schemas = cassette::fingerprint(response).into_iter().collect();
    let mut timeline = vec![format!("status:{}", response.status)];
    for line in response.body().lines() {
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let value: serde_json::Value = serde_json::from_str(data.trim())?;
        let kind = value["type"].as_str().unwrap_or("-");
        if matches!(
            kind,
            "response.output_item.added" | "response.output_item.done"
        ) && value["item"]["type"] == "reasoning"
        {
            continue;
        }
        let mut keys: Vec<_> = value
            .as_object()
            .map(|object| object.keys().cloned().collect())
            .unwrap_or_default();
        keys.sort();
        let entry = format!("{kind}{{{}}}", keys.join(","));
        if timeline.last() != Some(&entry) {
            timeline.push(entry);
        }
    }
    Ok((schemas, timeline))
}

// test-category: format-pin
#[test]
fn drift_preserves_message_completion_order_and_every_event_key() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let old = cassette::Cassette::load("MEM-03")?;
    let response = &old
        .exchanges
        .iter()
        .find(|exchange| exchange.request.key.user_request == PROMPT)
        .ok_or_else(|| harness_error("canonical exchange missing"))?
        .response;
    let expected = shape(response)?;
    let mut without_reasoning = response.clone();
    without_reasoning.chunks.retain(|chunk| {
        !chunk.text.lines().any(|line| {
            line.strip_prefix("data:")
                .and_then(|data| serde_json::from_str::<serde_json::Value>(data.trim()).ok())
                .is_some_and(|value| value["item"]["type"] == "reasoning")
        })
    });
    assert_eq!(
        shape(&without_reasoning)?,
        expected,
        "optional reasoning is not schema drift"
    );
    let mut reordered = without_reasoning.clone();
    let done = reordered
        .chunks
        .iter()
        .position(|chunk| chunk.text.starts_with("event: response.output_item.done"))
        .ok_or_else(|| harness_error("message completion missing"))?;
    let completion = reordered.chunks.remove(done);
    reordered.chunks.insert(0, completion);
    assert_ne!(
        shape(&reordered)?,
        expected,
        "message completion drift must fail"
    );
    let mut extra_key = without_reasoning;
    let chunk = &mut extra_key.chunks[0];
    chunk.text = chunk
        .text
        .replace("\"type\":", "\"new_upstream_key\":true,\"type\":");
    assert_ne!(shape(&extra_key)?, expected, "event key drift must fail");
    Ok(())
}
