//! External durable writers and shutdown flags wake a fully idle service.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test assertions")]
use butler_e2e::e2e::{HarnessError, cassette::Cassette, scenario::Setup};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::time::{Duration, Instant};

const NUMBERS: &str = "Write the numbers from one to twelve as English words, separated by single spaces, and nothing else.";

#[tokio::test]
async fn external_queue_and_stop_flag_preserve_complete_delivery() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("QUEUE-EXTERNAL-WAKE")?
        .cassette("TURN-01")
        .replay_only()
        .start()
        .await?;
    s.turn("general", NUMBERS).await?;
    s.agent.launch.set_env("BUTLER_E2E_TIER", "stub");
    s.agent.launch.set_env("BUTLER_E2E_HOLD_QUEUE_CLAIMS", "1");
    s.restart().await?;
    let created =
        s.gw.post("/sessions", json!({"kind":"chat","title":"External queue"}))
            .await?;
    assert_eq!(created.status, 201, "{}", created.text);
    let chats = [
        "general".to_owned(),
        created.data()["session"]["id"].as_str().unwrap().to_owned(),
    ];
    let pending = s.sandbox.data.join("runtime/inbound-events/pending");
    let held = s.sandbox.root.join("held-source-records");
    std::fs::create_dir_all(&held)?;
    let mut originals = Vec::new();
    for chat in &chats {
        let message = format!("client-{}", uuid::Uuid::new_v4());
        s.gw.send_message(json!({"chat_id":chat,"text":NUMBERS,"client_message_id":message}))
            .await?;
        let (path, record) = source_record(&s, &message).await?;
        let id = record["queueId"].as_str().unwrap().to_owned();
        std::fs::rename(path, held.join(format!("{id}.json")))?;
        originals.push((id, record["envelope"].clone()));
    }
    // Keep real App admission rows and signed controls. The separate test
    // process restores their exact durable source records without Notify.
    std::fs::write(s.sandbox.data.join("e2e-queue-claims-release"), b"release")?;
    let deadline = Instant::now() + Duration::from_secs(10);
    while s.sandbox.data.join("e2e-queue-claims-held").exists() {
        assert!(
            Instant::now() < deadline,
            "queue claims did not leave their test barrier"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    for (index, (id, _)) in originals.iter().enumerate() {
        let path = held.join(format!("{id}.json"));
        let mut record: Value = serde_json::from_slice(&std::fs::read(&path)?)?;
        if index == 1 {
            record["metadata"]["notBefore"] =
                json!((chrono::Utc::now() + chrono::Duration::seconds(1)).to_rfc3339());
        }
        let temporary = pending.join(format!("{id}.tmp"));
        std::fs::write(&temporary, serde_json::to_vec(&record)?)?;
        std::fs::rename(temporary, pending.join(format!("{id}.json")))?;
    }
    let deadline = Instant::now() + Duration::from_secs(60);
    for (id, original) in &originals {
        let path = s
            .sandbox
            .data
            .join("runtime/inbound-events/processed")
            .join(format!("{id}.json"));
        loop {
            if let Ok(bytes) = std::fs::read(&path) {
                let record: Value = serde_json::from_slice(&bytes)?;
                assert_eq!(record["envelope"], *original);
                assert_eq!(record["metadata"]["delivered"], 1, "{record}");
                if let Some(not_before) = record["metadata"]["notBefore"].as_str() {
                    let due = chrono::DateTime::parse_from_rfc3339(not_before).unwrap();
                    let done = chrono::DateTime::parse_from_rfc3339(
                        record["processedAt"].as_str().unwrap(),
                    )
                    .unwrap();
                    assert!(done >= due, "deferred record ran early: {record}");
                }
                break;
            }
            assert!(
                Instant::now() < deadline,
                "external queue was not delivered: {}",
                s.agent.logs()
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
    let answer = Cassette::load("TURN-01")?.exchanges[0]
        .response
        .output_text();
    assert_complete(&s.sandbox.data, &originals, answer.trim())?;
    assert_eq!(s.provider()?.requests().len(), 3);
    assert!(s.provider()?.misses().is_empty());
    let pid = s.agent.pid().unwrap();
    std::fs::write(s.sandbox.data.join("locks/butler-shutdown"), b"stop\n")?;
    let deadline = Instant::now() + Duration::from_secs(30);
    while s.agent.is_running() {
        assert!(
            Instant::now() < deadline,
            "external shutdown flag was not observed"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(
        s.agent.reap().unwrap().success(),
        "external stop failed for {pid}"
    );
    // Match the controller contract: retain stop intent until exit, then clear it.
    std::fs::remove_file(s.sandbox.data.join("locks/butler-shutdown"))?;
    s.gw = s.agent.start_again().await?;
    assert_complete(&s.sandbox.data, &originals, answer.trim())?;
    assert_eq!(
        s.provider()?.requests().len(),
        3,
        "restart repeated completed effects"
    );
    assert!(s.provider()?.misses().is_empty());
    s.finish().await
}

fn assert_complete(
    data: &std::path::Path,
    originals: &[(String, Value)],
    answer: &str,
) -> Result<(), HarnessError> {
    let db = Connection::open(data.join("agent-runtime/btcc.sqlite"))?;
    assert_eq!(originals.len(), 2);
    for (_, envelope) in originals {
        let id = envelope["routingHints"]["turnId"].as_str().unwrap();
        let (message, state, payload): (String,String,String) = db.query_row(
            "SELECT original_message,semantic_state,final_payload_json FROM btcc_turns WHERE turn_id=?1",
            [id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)))?;
        assert_eq!(message, NUMBERS);
        assert_eq!(state, "delivered");
        let payload: Value = serde_json::from_str(&payload)?;
        assert_eq!(payload["content"], answer);
    }
    Ok(())
}

async fn source_record(
    s: &butler_e2e::e2e::scenario::Scenario,
    message: &str,
) -> Result<(std::path::PathBuf, Value), HarnessError> {
    let root = s.sandbox.data.join("runtime/inbound-events/pending");
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        if let Ok(entries) = std::fs::read_dir(&root) {
            for entry in entries {
                let path = entry?.path();
                if path
                    .extension()
                    .is_some_and(|extension| extension == "json")
                {
                    let record: Value = serde_json::from_slice(&std::fs::read(&path)?)?;
                    if record
                        .pointer("/envelope/message/id")
                        .and_then(Value::as_str)
                        == Some(message)
                    {
                        assert_eq!(record["attempts"], 0);
                        return Ok((path, record));
                    }
                }
            }
        }
        assert!(
            Instant::now() < deadline,
            "App source admission was not queued"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
