//! LIVE-13: a thing named in one chat is used in another chat.
use butler_e2e::e2e::gateway::tool_rows;
use butler_e2e::e2e::{HarnessError, live, nonce};
use serde_json::json;

use super::{answer, done, live_turn, start};

/// LIVE-13 — A thing named in one chat is used in another chat.
#[tokio::test]
#[ignore = "LIVE tier"]
async fn live_13_earlier_chat_fact_used() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let Some((s, _)) = start("LIVE-13").await? else {
        return Ok(());
    };
    let name = format!("Pip{}", nonce());
    live_turn(
        &s,
        "general",
        &format!("I adopted an axolotl today and named her {name}."),
    )
    .await?;
    crate::memory_stubs::text_complete(&s.sandbox.data, 1).await?;
    let chat =
        s.gw.post("/sessions", json!({"kind": "chat", "title": "pet"}))
            .await?;
    let chat = chat.data()["session"]["id"].as_str().unwrap().to_owned();
    let (turn_id, _) = live_turn(
        &s,
        &chat,
        &format!(
            "{name} keeps floating near the top today. Is that a problem for her kind of animal?"
        ),
    )
    .await?;
    let text = answer(&s, &chat, &turn_id).await?.to_lowercase();
    let recalled = tool_rows(&s.gw.messages(&chat).await?, &turn_id)
        .iter()
        .any(|row| row.to_string().contains("recall_memory"));
    live::report("LIVE-13", &format!("recall_memory={recalled}"));
    assert!(
        text.contains("axolotl"),
        "answer did not use the earlier chat: {text}"
    );
    s.finish().await?;
    done("LIVE-13")
}
