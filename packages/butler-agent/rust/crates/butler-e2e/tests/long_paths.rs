//! Chat, config and CLI lifecycle beyond MAX_PATH and the SQLite staging budget.
#![allow(clippy::unwrap_used, reason = "test assertions")]

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::cassette::Cassette;
use butler_e2e::e2e::gateway::turn_state;
use butler_e2e::e2e::scenario::Setup;
use serde_json::json;

#[tokio::test]
async fn chat_and_config_survive_restart_under_long_data_path() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut setup = Setup::new("LONG-PATH")?.cassette("TURN-01").replay_only();
    // Components stay below NTFS's 255-character limit; the complete path
    // exceeds 280 characters, without an extended-path prefix in BUTLER_DATA.
    let mut data = setup.sandbox.root.clone();
    for _ in 0..5 {
        data = data.join("long-data-directory-component-012345678901234567890123456789");
    }
    // Reproduce the macOS CI failure: the old coordinator staging basename
    // made a 415-byte data path exceed SQLite's 512-byte Unix VFS budget.
    let bytes = data.as_os_str().as_encoded_bytes().len();
    if bytes < 415 {
        data = data.join("d".repeat(415 - bytes - 1));
    }
    assert!(data.as_os_str().as_encoded_bytes().len() >= 415);
    std::fs::create_dir_all(&data)?;
    setup.sandbox.data = data;
    setup
        .placeholders
        .add("D", setup.sandbox.data.display().to_string());
    let mut s = setup.start().await?;
    eprintln!(
        "BUTLER_DATA path length: {}",
        s.sandbox.data.to_string_lossy().chars().count()
    );
    let status = s.agent.cli(&["status", "--json"])?;
    assert_eq!(status.code, Some(0), "{status:?}");
    let started = s.agent.cli(&["start", "--json"])?;
    assert_eq!(started.code, Some(0), "{started:?}");
    assert_eq!(started.json()?["data"]["alreadyRunning"], true);
    let (_, turn) = s.turn("general", "Write the numbers from one to twelve as English words, separated by single spaces, and nothing else.").await?;
    assert_eq!(turn_state(&turn), "delivered");
    let messages = s.gw.messages("general").await?;
    assert_eq!(messages.len(), 2);
    let expected = Cassette::load("TURN-01")?
        .exchanges
        .first()
        .unwrap()
        .response
        .output_text();
    let assistant = messages
        .iter()
        .find(|message| message["role"] == "assistant")
        .unwrap();
    assert_eq!(assistant["text"], expected);
    let reply = s.gw.patch("/settings", json!({"language": "ko"})).await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    let config = std::fs::read(s.sandbox.data.join("butler.config.json"))?;
    let value: serde_json::Value = serde_json::from_slice(&config)?;
    assert_eq!(value["user"]["language"], "ko");
    s.restart().await?;
    assert_eq!(s.gw.messages("general").await?, messages);
    assert_eq!(
        std::fs::read(s.sandbox.data.join("butler.config.json"))?,
        config
    );
    let stopped = s.agent.cli_reaping(&["stop", "--json"]).await?;
    assert_eq!(stopped.code, Some(0), "{stopped:?}");
    assert!(!s.agent.is_running());
    assert!(!s.gw.healthy().await);
    s.finish().await
}
