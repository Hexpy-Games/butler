//! Delivery text is opaque; canonical identity must not rewrite its Unicode.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "E2E assertions")]
use butler_e2e::e2e::{
    HarnessError,
    cassette::{Cassette, Chunk},
    gateway::turn_state,
    scenario::Setup,
};
use serde_json::Value;
use std::time::Duration;

const ANSWER: &str = "Cafe\u{301} — \u{1100}\u{1161} — \u{212b} — 🦋";
const REQUEST: &str = "Write the numbers from one to twelve as English words, separated by single spaces, and nothing else.";

fn rewrite_text(value: &mut Value) {
    match value {
        Value::Object(map) => {
            if map
                .get("text")
                .and_then(Value::as_str)
                .is_some_and(|text| !text.is_empty())
            {
                map.insert("text".into(), ANSWER.into());
            }
            for value in map.values_mut() {
                rewrite_text(value);
            }
        }
        Value::Array(values) => values.iter_mut().for_each(rewrite_text),
        _ => {}
    }
}
fn cassette() -> Result<Cassette, HarnessError> {
    let mut cassette = Cassette::load("TURN-01")?;
    let mut chunks = Vec::new();
    let mut inserted = false;
    for chunk in &cassette.exchanges[0].response.chunks {
        for data in chunk
            .text
            .lines()
            .filter_map(|line| line.strip_prefix("data: "))
        {
            let mut event: Value = serde_json::from_str(data)?;
            if event["type"] == "response.output_text.delta" {
                if inserted {
                    continue;
                }
                event["delta"] = ANSWER.into();
                inserted = true;
            }
            rewrite_text(&mut event);
            chunks.push(Chunk {
                delay_ms: 0,
                text: format!("data: {event}\n\n"),
            });
        }
    }
    assert!(inserted);
    cassette.exchanges[0].response.chunks = chunks;
    Ok(cassette)
}

#[tokio::test]
async fn final_unicode_bytes_survive_delivery_and_restart() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("UNICODE-DELIVERY")?
        .stub_cassette(cassette()?)
        .start()
        .await?;
    let (id, turn) = s.turn("general", REQUEST).await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    for _ in 0..2 {
        let messages = s.gw.messages("general").await?;
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["text"], REQUEST);
        assert_eq!(messages[1]["role"], "assistant");
        assert_eq!(
            messages[1]["text"].as_str().unwrap().as_bytes(),
            ANSWER.as_bytes()
        );
        let view = s.gw.get("/session-view?session_id=general").await?;
        assert_eq!(view.status, 200, "{}", view.text);
        assert_eq!(view.data()["latest_turn"]["id"], id);
        assert_eq!(view.data()["message_window"]["complete"], true);
        assert_eq!(
            view.data()["messages"][1]["text"]
                .as_str()
                .unwrap()
                .as_bytes(),
            ANSWER.as_bytes()
        );
        s.restart().await?;
        let replay =
            s.gw.wait_terminal("general", &id, Duration::from_secs(60))
                .await?;
        assert_eq!(turn_state(&replay), "delivered", "{replay}");
    }
    s.agent.terminate().await?;
    emulate_legacy_normalization(&s.sandbox.data)?;
    s.gw = s.agent.start_again().await?;
    let legacy =
        s.gw.wait_terminal("general", &id, Duration::from_secs(60))
            .await?;
    assert_eq!(turn_state(&legacy), "delivered", "{legacy}");
    let messages = s.gw.messages("general").await?;
    assert_eq!(messages.len(), 2);
    assert_eq!(
        messages[1]["text"].as_str().unwrap().as_bytes(),
        ANSWER.as_bytes()
    );
    eprintln!(
        "UNICODE-DELIVERY complete_messages=2 exact_decomposed_and_compatibility_bytes=true completed_after_restart=true legacy_receipt_restored=true"
    );
    s.finish().await
}

// Reproduce the former writer's canonical normalization in both durable copies.
// Leave the original content hash and exact delivery receipt intact.
fn emulate_legacy_normalization(data: &std::path::Path) -> Result<(), HarnessError> {
    let db = butler_platform::sqlite::open(data.join("agent-runtime/btcc.sqlite"))?;
    let (turn, raw): (String, String) = db.query_row(
        "SELECT turn_id, final_payload_json FROM btcc_turns WHERE final_payload_json IS NOT NULL",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let mut payload: Value = serde_json::from_str(&raw)?;
    assert_eq!(
        payload["content"].as_str().unwrap().as_bytes(),
        ANSWER.as_bytes()
    );
    payload["content"] = "Café — 가 — Å — 🦋".into();
    let normalized = serde_json::to_string(&payload)?;
    assert_eq!(
        db.execute(
            "UPDATE btcc_turns SET final_payload_json=?1 WHERE turn_id=?2",
            rusqlite::params![normalized, turn]
        )?,
        1
    );
    assert_eq!(
        db.execute(
            "UPDATE btcc_records SET content_json=?1 WHERE record_id=?2 AND kind='final_payload'",
            rusqlite::params![normalized, payload["ref"]["id"].as_str().unwrap()]
        )?,
        1
    );
    Ok(())
}
