//! Compare request block bytes across 36 turns, allowing history-start rollover.
use super::*;

#[tokio::test]
async fn anthropic_cache_history_is_append_only_past_18_and_34_turns() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, stub, server) = start("1h", "on", true).await?;
    stub.text_only
        .store(true, std::sync::atomic::Ordering::Relaxed);
    let mut previous: Vec<Value> = Vec::new();
    let mut previous_history = String::new();
    let mut crossed = [false; 2];
    let mut rollovers = 0;
    for index in 0..36 {
        let begin = stub.requests.lock().unwrap().len();
        let (_, turn) = s.turn("general", &format!("compact {index}")).await?;
        assert_eq!(turn["state"], "delivered", "{turn}");
        let requests = stub.requests.lock().unwrap()[begin..].to_vec();
        assert_eq!(requests.len(), 1);
        layout(&requests[0], "1h", true);
        let mut blocks = requests[0]["messages"][0]["content"]
            .as_array()
            .unwrap()
            .clone();
        blocks.pop(); // The new request is volatile, outside completed history.
        for block in &mut blocks {
            block.as_object_mut().unwrap().remove("cache_control");
        }
        let retained = blocks
            .iter()
            .filter(|b| {
                b["text"]
                    .as_str()
                    .unwrap()
                    .trim_start()
                    .starts_with("turn ")
            })
            .count();
        for (slot, threshold) in [18, 34].into_iter().enumerate() {
            crossed[slot] |= index >= threshold;
        }
        let current_history = history(&s)?;
        assert_eq!(
            retained,
            current_history
                .lines()
                .filter(|line| line.starts_with("turn "))
                .count()
        );
        if index > 0 {
            if current_history.starts_with(&previous_history) {
                assert_eq!(blocks.len(), previous.len() + 1);
                assert_eq!(
                    serde_json::to_vec(&blocks[..previous.len()])?,
                    serde_json::to_vec(&previous)?,
                    "prefix bytes changed at {index}"
                );
            } else {
                rollovers += 1;
                assert_eq!(blocks[0], previous[0]);
            }
        }
        previous = blocks;
        previous_history = current_history;
    }
    assert_eq!(crossed, [true, true], "fixture missed turn thresholds");
    eprintln!("CACHE-APPEND turns=36 thresholds=18,34 rollovers={rollovers}");
    s.finish().await?;
    server.abort();
    Ok(())
}
