//! LIVE tier (SCENARIOS.md LIVE-01..10): real provider, coarse invariants.
//!
//! Every test is `#[ignore]` so the stub tier lists them as ignored. Run:
//! `BUTLER_E2E_TIER=live cargo test -p butler-e2e --test live -- --ignored --test-threads=1`.
//! Without credentials: tier `all` reports `SKIPPED (no credentials: ..)`,
//! tier `live` fails.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::fs;
use std::time::Duration;

use butler_e2e::e2e::config::{Credential, LiveProvider};
use butler_e2e::e2e::gateway::{tool_rows, turn_state};
use butler_e2e::e2e::scenario::{Scenario, Setup, accepted_turn_id};
use butler_e2e::e2e::{HarnessError, live, media, nonce};
use serde_json::{Value, json};

mod drift;
pub(super) mod profile;

const IGNORE: &str = "";

async fn start(id: &str) -> Result<Option<(Scenario, LiveProvider)>, HarnessError> {
    let Some(provider) = live::gate(id)? else {
        return Ok(None);
    };
    let setup = Setup::new(id)?.live(provider.clone());
    // Memory recall (LIVE-05) needs the local embedding model; installed
    // when available so the product does not download it.
    butler_e2e::e2e::fixtures::embedding_assets(&setup.sandbox.data)?;
    let s = setup.start().await?;
    Ok(Some((s, provider)))
}

async fn live_turn(s: &Scenario, chat: &str, text: &str) -> Result<(String, Value), HarnessError> {
    live::spend_turn()?;
    s.turn(chat, text).await
}

async fn answer(s: &Scenario, chat: &str, turn_id: &str) -> Result<String, HarnessError> {
    Ok(s.gw
        .messages(chat)
        .await?
        .iter()
        .filter(|m| m["role"] == "assistant" && m["turn_id"] == turn_id)
        .filter_map(|m| m["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n"))
}

fn done(id: &str) -> Result<(), HarnessError> {
    butler_e2e::gate!();
    live::report(id, "PASSED");
    Ok(())
}

/// LIVE-01 — Basic round trip (and (b) Korean answer language).
#[tokio::test]
#[ignore = "LIVE tier"]
async fn live_01_round_trip() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let _ = IGNORE;
    let Some((s, _)) = start("LIVE-01").await? else {
        return Ok(());
    };
    let n = nonce();
    let (turn_id, turn) = live_turn(
        &s,
        "general",
        &format!("Reply with exactly this token and nothing else: {n}"),
    )
    .await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    assert!(answer(&s, "general", &turn_id).await?.contains(&n));

    let reply =
        s.gw.patch("/personalization", json!({"response_language": "ko"}))
            .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    let chat =
        s.gw.post("/sessions", json!({"kind": "chat", "title": "ko"}))
            .await?;
    let chat = chat.data()["session"]["id"].as_str().unwrap().to_owned();
    let (turn_id, _) = live_turn(&s, &chat, "Say hello in one short sentence.").await?;
    let text = answer(&s, &chat, &turn_id).await?;
    assert!(
        text.chars().any(|c| ('\u{AC00}'..='\u{D7A3}').contains(&c)),
        "no Hangul: {text}"
    );
    s.finish().await?;
    done("LIVE-01")
}

/// LIVE-02 — Multi-turn context.
#[tokio::test]
#[ignore = "LIVE tier"]
async fn live_02_multi_turn_context() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let Some((s, _)) = start("LIVE-02").await? else {
        return Ok(());
    };
    let n = nonce();
    live_turn(
        &s,
        "general",
        &format!("Remember this code word for later: {n}. Just acknowledge."),
    )
    .await?;
    let (turn_id, turn) = live_turn(
        &s,
        "general",
        "What was the code word I gave you? Reply with only the code word.",
    )
    .await?;
    assert_eq!(turn_state(&turn), "delivered");
    assert!(answer(&s, "general", &turn_id).await?.contains(&n));
    s.finish().await?;
    done("LIVE-02")
}

/// LIVE-03 — Tool read.
#[tokio::test]
#[ignore = "LIVE tier"]
async fn live_03_tool_read() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let Some((s, _)) = start("LIVE-03").await? else {
        return Ok(());
    };
    let n = nonce();
    fs::write(s.sandbox.data.join("notes.txt"), format!("secret: {n}\n"))?;
    let (turn_id, turn) = live_turn(
        &s,
        "general",
        "Read notes.txt in your workspace and tell me the secret.",
    )
    .await?;
    assert_eq!(turn_state(&turn), "delivered");
    let rows = tool_rows(&s.gw.messages("general").await?, &turn_id);
    assert!(
        rows.iter().any(|row| row["safe_tool_name"] == "read_file"),
        "{rows:?}"
    );
    assert!(answer(&s, "general", &turn_id).await?.contains(&n));
    s.finish().await?;
    done("LIVE-03")
}

/// LIVE-04 — Tool write.
#[tokio::test]
#[ignore = "LIVE tier"]
async fn live_04_tool_write() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let Some((s, _)) = start("LIVE-04").await? else {
        return Ok(());
    };
    let n = nonce();
    let (_, turn) = live_turn(
        &s,
        "general",
        &format!("Create hello.txt in your workspace containing exactly: {n}"),
    )
    .await?;
    assert_eq!(turn_state(&turn), "delivered");
    assert!(fs::read_to_string(s.sandbox.data.join("hello.txt"))?.contains(&n));
    s.finish().await?;
    done("LIVE-04")
}

/// LIVE-05 — Cross-session recall (one retry).
#[tokio::test]
#[ignore = "LIVE tier"]
async fn live_05_cross_session_recall() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let Some((s, _)) = start("LIVE-05").await? else {
        return Ok(());
    };
    let n = nonce();
    live_turn(
        &s,
        "general",
        &format!("Please save an explicit durable memory: my locker combination is {n}."),
    )
    .await?;
    let chat =
        s.gw.post("/sessions", json!({"kind": "chat", "title": "recall"}))
            .await?;
    let chat = chat.data()["session"]["id"].as_str().unwrap().to_owned();
    let mut found = false;
    for _ in 0..2 {
        let (turn_id, _) = live_turn(
            &s,
            &chat,
            "What is my locker combination? Check your memory.",
        )
        .await?;
        if answer(&s, &chat, &turn_id).await?.contains(&n) {
            found = true;
            break;
        }
        live::report("LIVE-05", "retrying once");
    }
    assert!(found, "recall did not surface the fact");
    s.finish().await?;
    done("LIVE-05")
}

/// LIVE-06 — Image understanding.
#[tokio::test]
#[ignore = "LIVE tier"]
async fn live_06_image_understanding() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let Some((s, _)) = start("LIVE-06").await? else {
        return Ok(());
    };
    let digits = format!("{:04}", uuid::Uuid::new_v4().as_u128() % 10_000);
    let png = media::digits_png(&digits, 12);
    let upload =
        s.gw.upload("number.png", "image/png", &png, Some("general"))
            .await?;
    assert_eq!(upload.status, 201, "{}", upload.text);
    let file_id = upload.data()["file"]["file_id"]
        .as_str()
        .unwrap()
        .to_owned();
    live::spend_turn()?;
    let accepted = s
        .gw
        .send_message(json!({"chat_id": "general", "text": "What number is shown in the image? Reply with digits only.",
            "client_message_id": uuid::Uuid::new_v4().to_string(), "attachments": [{"file_id": file_id}]}))
        .await?;
    let turn_id = accepted_turn_id(&accepted)?;
    let turn =
        s.gw.wait_terminal("general", &turn_id, Duration::from_secs(300))
            .await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    let text = answer(&s, "general", &turn_id).await?;
    assert!(text.contains(&digits), "expected {digits}, got {text}");
    s.finish().await?;
    done("LIVE-06")
}

/// LIVE-07 — Model/effort matrix accepted by the provider.
#[tokio::test]
#[ignore = "LIVE tier"]
async fn live_07_model_matrix() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let Some((s, provider)) = start("LIVE-07").await? else {
        return Ok(());
    };
    for choice in &provider.matrix {
        s.select_model(choice).await?;
        let chat =
            s.gw.post(
                "/sessions",
                json!({"kind": "chat", "title": choice.label()}),
            )
            .await?;
        let chat = chat.data()["session"]["id"].as_str().unwrap().to_owned();
        let (_, turn) = live_turn(&s, &chat, "Reply with exactly: ok").await?;
        assert_eq!(turn_state(&turn), "delivered", "{}: {turn}", choice.label());
        assert_eq!(
            turn["execution_controls"]["model_ref"],
            choice.model.as_str()
        );
        if let Some(effort) = &choice.effort {
            assert_eq!(
                turn["execution_controls"]["reasoning_effort"],
                effort.as_str()
            );
        }
        live::report("LIVE-07", &format!("{} delivered", choice.label()));
    }
    s.finish().await?;
    done("LIVE-07")
}

/// LIVE-08 — Cancel on a real stream.
#[tokio::test]
#[ignore = "LIVE tier"]
async fn live_08_cancel_real_stream() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let Some((s, _)) = start("LIVE-08").await? else {
        return Ok(());
    };
    live::spend_turn()?;
    let accepted =
        s.gw.say(
            "general",
            "Write a 1500-word essay about the history of tea.",
        )
        .await?;
    let turn_id = accepted_turn_id(&accepted)?;
    tokio::time::sleep(Duration::from_secs(3)).await;
    let cancel =
        s.gw.post(&format!("/turns/{turn_id}/cancel"), json!({}))
            .await?;
    assert_eq!(cancel.status, 202, "{}", cancel.text);
    let turn =
        s.gw.wait_terminal("general", &turn_id, Duration::from_secs(30))
            .await?;
    assert_eq!(turn_state(&turn), "cancelled", "{turn}");
    let (_, next) = live_turn(&s, "general", "Reply with exactly: after-cancel").await?;
    assert_eq!(turn_state(&next), "delivered");
    s.finish().await?;
    done("LIVE-08")
}

/// LIVE-09 — Cassette drift: re-record the canonical exchange and compare
/// structural fingerprints (event types and key sets, not text).
#[tokio::test]
#[ignore = "LIVE tier"]
async fn live_09_cassette_drift() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let Some(provider) = live::gate("LIVE-09")? else {
        return Ok(());
    };
    drift::check(&provider).await?;
    done("LIVE-09")
}

/// LIVE-10 — Subscription token refresh (dedicated Butler or Codex profile).
#[tokio::test]
#[ignore = "LIVE tier"]
async fn live_10_subscription_token_refresh() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let Some(provider) = live::gate("LIVE-10")? else {
        return Ok(());
    };
    let Some(Credential::CodexProfile(path)) = provider.credential.clone() else {
        live::report("LIVE-10", "SKIPPED (needs a dedicated OAuth test profile)");
        return Ok(());
    };
    // Check the sibling lock before mutating the in-place login. The guard
    // restores only expiry on failure, preserving any rotated credentials.
    let probe = profile::ExpiryProbe::begin(path)?;
    let mut s = Setup::new("LIVE-10")?.live(provider).start().await?;
    let result = async {
        let (_, turn) = live_turn(&s, "general", "Reply with exactly: refreshed").await?;
        if turn_state(&turn) != "delivered" {
            return Err(butler_e2e::e2e::harness_error(
                "refresh turn was not delivered",
            ));
        }
        probe.verify(chrono::Utc::now().timestamp_millis())
    }
    .await;
    // Resolve expiry under the refresh gate while the agent is still alive.
    // Dropping the scenario first would kill an in-flight token publication.
    drop(probe);
    let stopped = s.agent.terminate().await;
    result?;
    stopped?;
    s.finish().await?;
    done("LIVE-10")
}
