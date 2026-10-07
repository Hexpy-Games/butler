//! A dedicated plain-answer baseline; old memory recordings remain replayable.
use std::collections::BTreeSet;
use std::path::PathBuf;

use butler_e2e::e2e::config::{LiveProvider, ModelChoice, flag, nonempty};
use butler_e2e::e2e::{HarnessError, cassette, harness_error, sanitize};

const BASELINE: &str = "LIVE-09";
pub(super) const PROMPT: &str = "Reply with exactly: memory check";

pub(super) async fn check(provider: &LiveProvider) -> Result<(), HarnessError> {
    let recording = flag("BUTLER_E2E_RECORD");
    let committed = cassette::Cassette::load(if recording { "MEM-03" } else { BASELINE })?;
    let index = committed
        .exchanges
        .iter()
        .position(|exchange| exchange.request.key.user_request == PROMPT)
        .ok_or_else(|| harness_error("canonical drift exchange missing"))?;
    if committed.meta.provider != provider.provider {
        return Err(harness_error(
            "drift baseline provider does not match live provider",
        ));
    }
    // Live recording must never inherit another model from a historical cassette.
    let choice = ModelChoice::parse("openai/gpt-6-luna@max")
        .ok_or_else(|| harness_error("invalid drift recording model"))?;
    let temporary = std::env::temp_dir().join(format!(
        "butler-e2e-drift-{}",
        uuid::Uuid::new_v4().simple()
    ));
    let s = super::Setup::new(BASELINE)?
        .cassette(BASELINE)
        .model(choice)
        .record_into(temporary.clone())
        .start()
        .await?;
    let (_, turn) = super::live_turn(&s, "general", PROMPT).await?;
    assert_eq!(super::turn_state(&turn), "delivered");
    s.finish().await?;
    let mut fresh = canonical(cassette::load_from(&temporary, BASELINE)?)?;
    std::fs::remove_dir_all(&temporary)?;
    if recording {
        let output = PathBuf::from(
            nonempty("BUTLER_E2E_RECORD_OUTPUT")
                .ok_or_else(|| harness_error("recording requires an explicit cassette output"))?,
        );
        fresh.exchanges[0].response.headers.clear();
        fresh
            .meta
            .sanitization
            .push("all response headers removed".into());
        for exchange in &fresh.exchanges {
            assert!(
                sanitize::lint(&serde_json::to_string(exchange)?).is_empty(),
                "recorded cassette failed secret scrub"
            );
        }
        cassette::write(&output, fresh.meta, &fresh.exchanges)?;
        super::live::report(BASELINE, "RECORDED (openai/gpt-6-luna, sanitized)");
    } else {
        assert_eq!(
            shape(&fresh.exchanges[0].response)?,
            shape(&committed.exchanges[index].response)?,
            "provider stream shape drifted; re-record cassettes (BUTLER_E2E_RECORD=1)"
        );
    }
    Ok(())
}

// Memory maintenance shares the recording proxy. Select the exact caller's
// exchange, preserving its complete response; never assume it arrived first.
fn canonical(mut recorded: cassette::Cassette) -> Result<cassette::Cassette, HarnessError> {
    recorded
        .exchanges
        .retain(|exchange| exchange.request.key.user_request == PROMPT);
    if recorded.exchanges.len() != 1 {
        return Err(harness_error(
            "drift turn must have exactly one canonical exchange",
        ));
    }
    let response = &recorded.exchanges[0].response;
    if response.status != 200 || response.output_text().is_empty() {
        return Err(harness_error(
            "canonical drift response must be complete and successful",
        ));
    }
    Ok(recorded)
}

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
