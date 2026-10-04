//! NFC/NFD differences cannot prevent recovery of a committed delivery.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    scenario::{Scenario, Setup, accepted_turn_id},
};
use butler_platform::sqlite;
use serde_json::{Value, json};
use std::time::{Duration, Instant};

const NFC: &str = "키센스.txt";
const NFD: &str = "키센스.txt";

#[tokio::test]
async fn normalized_outbox_delivers_once_across_both_restart_windows() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for phase in ["before", "after"] {
        let mut cassette = Cassette::load("TURN-01")?;
        let prompt = cassette.exchanges[0].request.key.user_request.clone();
        korean_response(&mut cassette);
        let mut s = Setup::new(&format!("OUTBOX-NORMALIZATION-{phase}"))?
            .stub_cassette(cassette)
            .env("BUTLER_E2E_TIER", "stub")
            .env("BUTLER_E2E_HOLD_DELIVERY", phase)
            .start()
            .await?;
        let started = Instant::now();
        let id = accepted_turn_id(&s.gw.say("general", &prompt).await?)?;
        wait_held(&s, &id).await?;
        s.agent.kill9()?;
        change_stored_text(&s, &id, phase);
        s.agent.launch.set_env("BUTLER_E2E_HOLD_DELIVERY", "");
        s.gw = s.agent.start_again().await?;
        resume_interrupted(&s, &id).await?;
        assert_delivered(&s, &id, phase).await?;
        // Replay the completed queue/admission identity with the same client id.
        let client = {
            let db = sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite")).unwrap();
            db.query_row(
                "SELECT client_message_id FROM session_queued_messages WHERE turn_id=?1",
                [&id],
                |row| row.get::<_, String>(0),
            )
            .unwrap()
        };
        let reply =
            s.gw.post(
                "/messages",
                json!({"chat_id":"general","text":prompt,"client_message_id":client}),
            )
            .await?;
        assert_eq!(reply.status, 202, "{reply:?}");
        s.restart().await?;
        assert_delivered(&s, &id, phase).await?;
        assert_eq!(s.provider()?.served(), 1, "restart repeated model work");
        eprintln!(
            "{phase} normalization/restart delivery: {:?}; canonical=1, receipt=1, model_calls=1",
            started.elapsed()
        );
        s.finish().await?;
    }
    Ok(())
}

async fn wait_held(s: &Scenario, id: &str) -> Result<(), HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(20);
    let marker = s.sandbox.data.join("e2e-delivery-held");
    loop {
        if std::fs::read_to_string(&marker).ok().as_deref() == Some(id) {
            return Ok(());
        }
        assert!(
            Instant::now() < deadline,
            "delivery barrier missing\n{}",
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn change_stored_text(s: &Scenario, id: &str, phase: &str) {
    let db = sqlite::open(s.sandbox.data.join("agent-runtime/btcc.sqlite")).unwrap();
    let (mut payload, content, status): (Value, String, String) = db.query_row(
        "SELECT t.final_payload_json,o.content,o.status FROM btcc_turns t JOIN btcc_delivery_outbox o ON o.outbox_id=t.delivery_outbox_id WHERE t.turn_id=?1", [id],
        |row| Ok((serde_json::from_str(&row.get::<_, String>(0)?).unwrap(),row.get(1)?,row.get(2)?))).unwrap();
    assert_eq!(content, NFD);
    assert_eq!(
        status,
        if phase == "before" {
            "pending"
        } else {
            "inserted"
        }
    );
    payload["content"] = NFC.into();
    // Deliberately differ from both the raw-text hash and the outbox's payload hash.
    payload["contentSha256"] = "0".repeat(64).into();
    payload["ref"]["sha256"] = "1".repeat(64).into();
    db.execute(
        "UPDATE btcc_turns SET final_payload_json=?1 WHERE turn_id=?2",
        rusqlite::params![payload.to_string(), id],
    )
    .unwrap();
    let changed = db
        .execute(
            "UPDATE btcc_messages SET content=?1 WHERE turn_id=?2 AND role='assistant'",
            rusqlite::params![NFC, id],
        )
        .unwrap();
    assert_eq!(changed, usize::from(phase == "after"));
    // Claim restoration and explicit retry also use ids when admission text
    // was normalized differently in the queue and its projected message.
    let app = sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite")).unwrap();
    app.execute(
        "UPDATE messages SET text=?1 WHERE turn_id=?2 AND role='user'",
        rusqlite::params![NFC, id],
    )
    .unwrap();
    app.execute(
        "UPDATE session_queued_messages SET text=?1 WHERE turn_id=?2",
        rusqlite::params![NFD, id],
    )
    .unwrap();
}

async fn assert_delivered(s: &Scenario, id: &str, phase: &str) -> Result<(), HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let turn = s.gw.turn("general", id).await?.unwrap();
        if turn["state"] == "delivered" {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "delivery stalled: {turn}\n{}",
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let messages = s.gw.messages("general").await?;
    let answers: Vec<_> = messages
        .iter()
        .filter(|m| m["role"] == "assistant" && m["turn_id"] == id)
        .collect();
    assert_eq!(answers.len(), 1, "{messages:?}");
    assert_eq!(answers[0]["text"], NFD);
    assert_eq!(s.gw.turns("general").await?.len(), 1);
    let db = sqlite::open(s.sandbox.data.join("agent-runtime/btcc.sqlite")).unwrap();
    let (count, text): (i64, String) = db
        .query_row(
            "SELECT count(*),content FROM btcc_messages WHERE turn_id=?1 AND role='assistant'",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(count, 1);
    assert_eq!(text, if phase == "after" { NFC } else { NFD });
    let receipts: i64 = db
        .query_row(
            "SELECT count(*) FROM btcc_canonical_deliveries WHERE turn_id=?1",
            [id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(receipts, 1);
    let status: String = db
        .query_row(
            "SELECT status FROM btcc_delivery_outbox WHERE turn_id=?1",
            [id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(status, "observed");
    Ok(())
}

fn korean_response(cassette: &mut Cassette) {
    let mut first_delta = true;
    for chunk in &mut cassette.exchanges[0].response.chunks {
        chunk.text = chunk
            .text
            .lines()
            .map(|line| {
                let Some(data) = line.strip_prefix("data: ") else {
                    return line.to_owned();
                };
                let Ok(mut event) = serde_json::from_str::<Value>(data) else {
                    return line.to_owned();
                };
                if event["type"] == "response.output_text.delta" {
                    event["delta"] = if first_delta { NFD } else { "" }.into();
                    first_delta = false;
                }
                for pointer in [
                    "/text",
                    "/item/content/0/text",
                    "/response/output/0/content/0/text",
                ] {
                    if let Some(text) = event.pointer_mut(pointer) {
                        *text = NFD.into();
                    }
                }
                format!("data: {event}")
            })
            .collect::<Vec<_>>()
            .join("\n")
            + "\n\n";
    }
    assert_eq!(cassette.exchanges[0].response.output_text(), NFD);
}

async fn resume_interrupted(s: &Scenario, id: &str) -> Result<(), HarnessError> {
    // Preserve the owner's policy: crashed active input needs explicit retry.
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let turn = s.gw.turn("general", id).await?.unwrap();
        if turn["state"] == "failed" {
            assert_eq!(turn["retryable"], true);
            break;
        }
        assert!(
            Instant::now() < deadline,
            "interruption not reported: {turn}\n{}",
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let retry = s.gw.post(&format!("/turns/{id}/retry"), json!({})).await?;
    assert_eq!(retry.status, 202, "{retry:?}");
    Ok(())
}
