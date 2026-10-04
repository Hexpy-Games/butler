//! Context diagnostics follow telemetry appends and rotations through session-view.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "E2E assertions")]
use butler_e2e::e2e::{
    HarnessError,
    scenario::{Scenario, Setup},
};
use serde_json::{Value, json};
use std::{fs, io::Write, path::Path};

fn row(turn: &str, count: u64) -> Value {
    json!({"ts":4_000_000_000_000_i64,"scope":"btcc-guided:butler/app-general",
        "turnId":turn,"model":"openai/gpt-6-luna","promptTokens":count})
}
fn append(path: &Path, value: &Value, newline: bool) {
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .unwrap();
    write!(file, "{value}").unwrap();
    if newline {
        writeln!(file).unwrap();
    }
}
async fn context(s: &Scenario, count: u64, source: &str) -> Result<Value, HarnessError> {
    let view = s.gw.get("/session-view?session_id=general").await?;
    assert_eq!(view.status, 200, "{}", view.text);
    let data = view.data();
    assert_eq!(data["message_window"]["complete"], true);
    assert_eq!(data["messages"].as_array().unwrap().len(), 2);
    assert_eq!(data["context"]["used_tokens"], count, "{}", data["context"]);
    assert_eq!(data["context"]["token_count_source"], source);
    Ok(data["context"].clone())
}

#[tokio::test]
async fn session_context_tracks_appends_partial_rows_and_same_prefix_rotation()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("CONTEXT-TELEMETRY")?
        .cassette("TURN-01")
        // The fixture writes valid EOF/partial rows itself. Keep the unrelated
        // background extractor from appending another record inside those rows.
        .env("BUTLER_E2E_HOLD_MEMORY_BOOTSTRAP", "1")
        .start()
        .await?;
    let (turn, delivered) = s.turn("general", "Write the numbers from one to twelve as English words, separated by single spaces, and nothing else.").await?;
    assert_eq!(delivered["state"], "delivered");
    let path = s.sandbox.data.join("metrics/prompt-cache-usage.jsonl");
    append(&path, &row(&turn, 321), true);
    context(&s, 321, "provider_prompt_usage").await?;
    append(&path, &row(&turn, 654), false);
    // A valid EOF row is visible immediately; repeating the read must not lose it.
    context(&s, 654, "provider_prompt_usage").await?;
    context(&s, 654, "provider_prompt_usage").await?;
    let next = row(&turn, 987).to_string();
    let (first, last) = next.split_at(next.len() / 2);
    let mut file = fs::OpenOptions::new().append(true).open(&path)?;
    writeln!(file)?;
    file.write_all(first.as_bytes())?;
    drop(file);
    context(&s, 654, "provider_prompt_usage").await?;
    let mut file = fs::OpenOptions::new().append(true).open(&path)?;
    writeln!(file, "{last}")?;
    drop(file);
    context(&s, 987, "provider_prompt_usage").await?;
    let prefix = format!(
        "{}\n",
        json!({"scope":"unrelated","padding":"x".repeat(300)})
    );
    let replacement = path.with_extension("replacement");
    fs::write(&replacement, format!("{prefix}{}\n", row(&turn, 222)))?;
    fs::remove_file(&path)?;
    fs::rename(&replacement, &path)?;
    context(&s, 222, "provider_prompt_usage").await?;
    // Rewrite only beyond the unchanged first 256 bytes, preserving file length.
    fs::write(&path, format!("{prefix}{}\n", row(&turn, 333)))?;
    append(&path, &json!({"scope":"unrelated","promptTokens":1}), true);
    context(&s, 333, "provider_prompt_usage").await?;
    fs::remove_file(&path)?;
    let monitor = s.sandbox.data.join("metrics/context-monitor.jsonl");
    fs::write(
        &monitor,
        format!(
            "{}\n",
            json!({"kind":"runtime_turn","ts":4_000_000_000_001_i64,
        "sessionId":"butler/app-general","totalPromptChars":2000})
        ),
    )?;
    context(&s, 500, "context_monitor").await?;
    append(&path, &row(&turn, 444), true);
    // Exact-turn provider data wins even over a later monitor observation.
    context(&s, 444, "provider_prompt_usage").await?;
    // Preserve the existing JSONL ceiling and continue with every valid later row.
    let mut oversized = row(&turn, 999);
    oversized["padding"] = json!("x".repeat(1024 * 1024));
    append(&path, &oversized, true);
    context(&s, 444, "provider_prompt_usage").await?;
    append(&path, &row(&turn, 777), true);
    context(&s, 777, "provider_prompt_usage").await?;
    s.finish().await
}
