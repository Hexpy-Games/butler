//! Already omitted turns must fold even below the normal batching threshold.
use super::*;

#[tokio::test]
async fn omitted_candidates_fold_below_eight_thousand_tokens() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, stub, server) = start_with("1h", "on", true, &[]).await?;
    stub.text_only
        .store(true, std::sync::atomic::Ordering::Relaxed);
    register_small_model(&s).await?;
    let controls =
        s.gw.patch(
            "/sessions/general/controls",
            json!({"model":"anthropic/claude-haiku-4-5"}),
        )
        .await?;
    assert_eq!(controls.status, 200, "{}", controls.text);
    s.turn("general", FACT).await?;
    s.agent.terminate().await?;
    let id = seed(
        &s.sandbox.data.join("runtime/conversation-store.sqlite"),
        32,
        2600,
    )?;
    let path = summary_path(&s, &id);
    s.gw = s.agent.start_again().await?;
    s.turn("general", "Begin continuity catch-up.").await?;
    settle(&path, &stub).await?;
    let original = through(&path)?;
    let count = stub.continuity.requests.lock().unwrap().len();
    let first = omitted(&recent(&s)?);
    let mut added_tokens = 0;
    for index in 0..7 {
        let ask = format!(
            "Subthreshold follow-up {index}: {}end",
            "more context ".repeat(260)
        );
        added_tokens +=
            butler_core::json::saturating_usize((ask.chars().count() as f64 / 3.8).ceil()) + 160;
        s.turn("general", &ask).await?;
        if omitted(&recent(&s)?) <= first {
            continue;
        }
        assert!(
            added_tokens < 8_000,
            "fixture must remain below the batching threshold"
        );
        let deadline = Instant::now() + Duration::from_secs(3);
        while through(&path)? == original && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        assert!(
            through(&path)? > original,
            "already omitted candidates were not folded below 8,000 tokens"
        );
        assert!(stub.continuity.requests.lock().unwrap().len() > count);
        eprintln!(
            "CONTINUITY-FOLD-EDGE new_turns={} added_token_upper_bound={added_tokens} through_seq={}",
            index + 1,
            through(&path)?
        );
        s.finish().await?;
        server.abort();
        return Ok(());
    }
    panic!("fixture never advanced its history window");
}

fn omitted(text: &str) -> u64 {
    assert!(text.starts_with("Older turns omitted: "));
    text.split_whitespace().nth(3).unwrap().parse().unwrap()
}

fn through(path: &Path) -> Result<u64, HarnessError> {
    let content = std::fs::read_to_string(path)?;
    let marker = content
        .lines()
        .next()
        .unwrap()
        .strip_prefix("<!-- butler-continuity ")
        .unwrap()
        .strip_suffix(" -->")
        .unwrap();
    let value: Value = serde_json::from_str(marker)?;
    Ok(value["through_seq"].as_u64().unwrap())
}
