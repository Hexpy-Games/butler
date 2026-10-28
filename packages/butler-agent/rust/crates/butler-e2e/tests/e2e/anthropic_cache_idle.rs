//! Separate elapsed-time stability from bounded history window rollover.
use super::*;
use butler_e2e::e2e::fixtures::FIXTURE_TIME;
use std::io::{BufRead, BufReader, Write};
use std::time::Duration;

/// Past the provider's default 5-minute cache TTL.
const IDLE_SECONDS: i64 = 361;

/// Set the agent's stub-tier App clock through its loopback control.
async fn set_app_clock(address: String, now: String) -> Result<Value, HarnessError> {
    tokio::task::spawn_blocking(move || -> Result<Value, HarnessError> {
        let mut stream = std::net::TcpStream::connect(address)?;
        stream.set_read_timeout(Some(Duration::from_secs(1)))?;
        writeln!(stream, "{now}")?;
        let mut reply = String::new();
        BufReader::new(stream).read_line(&mut reply)?;
        Ok(serde_json::from_str(&reply)?)
    })
    .await
    .map_err(|e| HarnessError(e.to_string()))?
}

#[tokio::test]
async fn six_minute_idle_preserves_stable_and_completed_history_bytes() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    let clock = listener.local_addr()?.to_string();
    drop(listener);
    let env = [("BUTLER_E2E_APP_CLOCK_ADDRESS", clock.as_str())];
    let (s, stub, server) = start_with("1h", "on", true, &env).await?;
    s.turn("general", "warm cache before idle").await?;
    s.turn("general", "capture completed history before idle")
        .await?;
    let before = stub.requests.lock().unwrap().last().unwrap().clone();
    let previous = history_blocks(&before);
    // Advance the agent's clock instead of sleeping through the idle period.
    let idle_until = (chrono::DateTime::parse_from_rfc3339(FIXTURE_TIME)
        .map_err(|e| HarnessError(e.to_string()))?
        + chrono::Duration::seconds(IDLE_SECONDS))
    .with_timezone(&chrono::Utc)
    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let state = set_app_clock(clock, idle_until.clone()).await?;
    assert_eq!(state["now"], idle_until.as_str(), "{state}");
    let begin = stub.requests.lock().unwrap().len();
    s.turn("general", "resume cache after six minute idle")
        .await?;
    let after = stub.requests.lock().unwrap()[begin].clone();
    let current = history_blocks(&after);
    let resumed_at = format!("Current Time UTC: {idle_until}");
    assert!(
        after.to_string().contains(&resumed_at),
        "the resumed turn did not observe the idle clock"
    );
    assert_eq!(before["system"], after["system"]);
    assert_eq!(before["tools"], after["tools"]);
    assert!(
        current.starts_with(&previous),
        "idle changed completed history bytes"
    );
    assert_eq!(current.len(), previous.len() + 1);
    eprintln!(
        "CACHE-IDLE idle_seconds={IDLE_SECONDS} unchanged_blocks={} stable_and_history_prefix=100%",
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
        s.turn(
            "general",
            &format!(
                "bounded history cache request {index}: {}end",
                "cached history context ".repeat(1000)
            ),
        )
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
                    .starts_with("Older turns omitted: ")
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
