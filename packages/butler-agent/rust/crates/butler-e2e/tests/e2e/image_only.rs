//! Image-only input through the App's upload and message endpoints.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::time::{Duration, Instant};

use butler_e2e::e2e::events::{LiveEvents, event_turn_id};
use butler_e2e::e2e::gateway::turn_state;
use butler_e2e::e2e::provider::Script;
use butler_e2e::e2e::scenario::{Setup, accepted_turn_id};
use butler_e2e::e2e::{HarnessError, media};
use serde_json::json;

#[tokio::test]
async fn image_only_is_delivered_with_persisted_image_and_provider_image()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("IMAGE-ONLY")?
        .synthetic(Script {
            rounds: 0,
            path_for: Box::new(|_| String::new()),
            final_text: "Image received.".into(),
        })
        .start()
        .await?;
    let live = LiveEvents::subscribe(&s.gw, 0).await?;
    let upload =
        s.gw.upload(
            "number.png",
            "image/png",
            &media::digits_png("4821", 12),
            Some("general"),
        )
        .await?;
    assert_eq!(upload.status, 201, "{}", upload.text);
    let file_id = upload.data()["file"]["file_id"].as_str().unwrap();
    let sent =
        s.gw.post(
            "/messages",
            json!({"chat_id":"general", "text":"",
        "attachments":[{"file_id":file_id}], "client_message_id":uuid::Uuid::new_v4().to_string()}),
        )
        .await?;
    assert_eq!(sent.status, 202, "{}", sent.text);
    let turn_id = accepted_turn_id(sent.data())?;
    let started = Instant::now();
    let terminal =
        s.gw.wait_terminal("general", &turn_id, Duration::from_secs(15))
            .await;
    let events = s.gw.events_since(0).await?;
    let states: Vec<_> = events
        .iter()
        .filter(|e| event_turn_id(e) == Some(&turn_id) && e["type"] == "turn.state_changed")
        .map(|e| {
            e["payload"]
                .get("state")
                .unwrap_or(&e["payload"]["turn"]["state"])
                .clone()
        })
        .collect();
    eprintln!(
        "image-only: HTTP={}, states={states:?}, provider_requests={}, elapsed={:?}",
        sent.status,
        s.provider()?.requests().len(),
        started.elapsed()
    );
    let terminal = terminal?;
    assert_eq!(turn_state(&terminal), "delivered", "{terminal}");
    let messages = s.gw.messages("general").await?;
    let user = messages
        .iter()
        .find(|m| m["role"] == "user")
        .expect("persisted user");
    assert_eq!(user["text"], "");
    assert_eq!(user["attachments"][0]["file_id"], file_id);
    assert!(
        messages
            .iter()
            .any(|m| m["role"] == "assistant" && m["text"] == "Image received."),
        "{messages:?}"
    );
    let requests = s.provider()?.requests();
    assert_eq!(requests.len(), 1);
    assert!(
        requests[0]["input"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["role"] == "user"
                && m["content"]
                    .as_array()
                    .is_some_and(|parts| parts.iter().any(|p| p["type"] == "input_image"))),
        "provider lost image"
    );
    live.wait_for(Duration::from_secs(5), |e| {
        event_turn_id(e) == Some(&turn_id)
            && (e["payload"]["state"] == "delivered"
                || e["payload"]["turn"]["state"] == "delivered")
    })
    .await?;
    s.finish().await
}

#[tokio::test]
async fn image_only_missing_queued_payload_emits_terminal_failure() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("IMAGE-MISSING")?
        .synthetic(Script {
            rounds: 0,
            path_for: Box::new(|_| String::new()),
            final_text: "Ready.".into(),
        })
        .start()
        .await?;
    let settings = s.gw.patch("/settings", json!({"language":"ko"})).await?;
    assert_eq!(settings.status, 200, "{}", settings.text);
    let live = LiveEvents::subscribe(&s.gw, 0).await?;
    let upload =
        s.gw.upload(
            "number.png",
            "image/png",
            &media::digits_png("4821", 12),
            Some("general"),
        )
        .await?;
    assert_eq!(upload.status, 201, "{}", upload.text);
    let client = format!("client-{}", uuid::Uuid::new_v4());
    let queued =
        s.gw.post(
            "/session-queue",
            json!({"chat_id":"general", "text":"",
        "attachments":[{"file_id":upload.data()["file"]["file_id"]}], "client_message_id":client}),
        )
        .await?;
    assert_eq!(queued.status, 202, "{}", queued.text);
    let mut deleted = 0;
    for entry in std::fs::read_dir(s.sandbox.data.join("app-server/message-files"))? {
        let entry = entry?;
        if entry.file_name().to_string_lossy().contains(".visual.") {
            std::fs::remove_file(entry.path())?;
            deleted += 1;
        }
    }
    assert_eq!(deleted, 1);
    s.gw.say("general", "Continue.").await?;
    let deadline = Instant::now() + Duration::from_secs(15);
    let failed = loop {
        let turns = s.gw.turns("general").await?;
        if let Some(turn) = turns
            .iter()
            .find(|t| t["user_message_id"] == client && turn_state(t) == "failed")
            && turns.iter().any(|t| turn_state(t) == "delivered")
        {
            break turn.clone();
        }
        assert!(
            Instant::now() < deadline,
            "missing image never settled: {turns:?}"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    let events = s.gw.events_since(0).await?;
    let turn_id = failed["id"].as_str().unwrap();
    assert!(
        events.iter().any(|e| e["type"] == "turn.state_changed"
            && event_turn_id(e) == Some(turn_id)
            && e["payload"]["state"] == "failed"),
        "missing terminal failure event: {events:?}"
    );
    assert!(
        s.gw.messages("general")
            .await?
            .iter()
            .any(|m| m["turn_id"] == turn_id
                && m["role"] == "assistant"
                && m["status"] == "failed"
                && m["text"] == "버틀러 응답 실패"),
        "missing visible failure message"
    );
    live.wait_for(Duration::from_secs(5), |e| {
        e["type"] == "turn.failed" && event_turn_id(e) == Some(turn_id)
    })
    .await?;
    s.finish().await
}

#[tokio::test]
async fn image_only_empty_or_unknown_attachment_is_rejected_before_turn_admission()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("IMAGE-INVALID")?.start().await?;
    for attachments in [json!([]), json!([{"file_id":"file-unknown"}])] {
        let reply =
            s.gw.post(
                "/messages",
                json!({"chat_id":"general", "text":"", "attachments":attachments}),
            )
            .await?;
        assert!(reply.status >= 400 && reply.status < 500, "{}", reply.text);
        assert!(reply.error_code().is_some());
        assert_ne!(
            reply.body["error"]["message"].as_str().unwrap_or_default(),
            ""
        );
        assert!(
            s.gw.turns("general").await?.is_empty(),
            "rejected request left a running turn"
        );
    }
    s.finish().await
}
