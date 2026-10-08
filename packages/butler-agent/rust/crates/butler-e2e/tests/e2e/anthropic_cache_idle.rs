//! Separate elapsed-time stability from bounded history window rollover.
use super::*;
use std::time::{Duration, Instant};

#[tokio::test]
async fn six_minute_idle_preserves_stable_and_completed_history_bytes() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let (s, stub, server) = start("1h", "on", true).await?;
    s.turn("general", "warm cache before idle").await?;
    s.turn("general", "capture completed history before idle")
        .await?;
    let before = stub.requests.lock().unwrap().last().unwrap().clone();
    let previous = history_blocks(&before);
    let began = Instant::now();
    tokio::time::sleep(Duration::from_secs(361)).await;
    let begin = stub.requests.lock().unwrap().len();
    s.turn("general", "resume cache after six minute idle")
        .await?;
    let after = stub.requests.lock().unwrap()[begin].clone();
    let current = history_blocks(&after);
    assert_eq!(before["system"], after["system"]);
    assert_eq!(before["tools"], after["tools"]);
    assert!(
        current.starts_with(&previous),
        "idle changed completed history bytes"
    );
    assert_eq!(current.len(), previous.len() + 1);
    eprintln!(
        "CACHE-IDLE idle_seconds={} unchanged_blocks={} stable_and_history_prefix=100%",
        began.elapsed().as_secs(),
        previous.len()
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn history_rollover_preserves_independent_stable_docs_breakpoint() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let (s, stub, server) = start("1h", "on", true).await?;
    let mut stable = String::new();
    let mut rollovers = 0;
    for index in 0..16 {
        let begin = stub.requests.lock().unwrap().len();
        s.turn("general", &format!("bounded history cache request {index}"))
            .await?;
        let request = stub.requests.lock().unwrap()[begin].clone();
        let blocks = request["messages"][0]["content"].as_array().unwrap();
        let docs = blocks[0]["text"].as_str().unwrap();
        if index == 0 {
            stable = docs.to_owned();
        }
        assert_eq!(
            docs, stable,
            "history digest changed stable docs at turn {index}"
        );
        if history(&s)?.contains("dropped turn ") {
            rollovers += 1;
            assert_eq!(
                blocks[0]["cache_control"]["ttl"], "1h",
                "stable docs need their own cache write when history rolls over"
            );
            assert!(
                blocks[1]["text"]
                    .as_str()
                    .unwrap()
                    .starts_with("dropped turn ")
            );
        }
        assert!(controls(&request) <= 4);
        let rendered = blocks
            .iter()
            .map(|b| b["text"].as_str().unwrap())
            .collect::<String>();
        assert!(
            rendered.contains(&history(&s)?),
            "history content dropped or reordered"
        );
    }
    assert!(rollovers > 0, "fixture never crossed history budget");
    eprintln!("CACHE-ROLLOVER turns=16 digest_windows={rollovers} stable_docs_prefix=100%");
    s.finish().await?;
    server.abort();
    Ok(())
}
