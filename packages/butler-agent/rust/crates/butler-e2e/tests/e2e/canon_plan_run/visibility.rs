use super::*;
use std::time::Duration;

#[tokio::test]
async fn canon_step_prompt_is_absent_from_every_owner_read() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, first, chat) =
        crate::canon_link::setup("CANON-PROMPT-VISIBILITY", false, false).await?;
    let project = data(s.gw.get(&format!("/canon/epics/{first}")).await?, 200)["project_id"]
        .as_str()
        .unwrap()
        .to_owned();
    data(
        s.gw.post(
            &format!("/sessions/{chat}/canon/queue"),
            json!({"op":"start_now","epic_id":first}),
        )
        .await?,
        200,
    );
    script.wait_held().await;
    script.release();
    wait_done(&s, &chat, 1).await?;
    for turn in s.gw.turns(&chat).await? {
        s.gw.wait_terminal(&chat, turn["id"].as_str().unwrap(), Duration::from_secs(60))
            .await?;
    }
    let messages = s.gw.messages(&chat).await?;
    assert!(
        messages.iter().any(|m| m["role"] == "assistant"
            && m["text"]
                .as_str()
                .is_some_and(|t| t.contains("verified the evidence"))
            && m["initiated"]["kind"] == "canon_step"),
        "{messages:?}"
    );
    for path in [
        format!("/messages?chat_id={chat}"),
        format!("/messages?chat_id={chat}&limit=1&after_cursor=0"),
        format!("/session-view?session_id={chat}"),
        format!("/session-summary?session_id={chat}"),
        format!("/session-queue?session_id={chat}"),
        format!("/sessions/{chat}/canon/queue"),
        format!("/transcript-export?session_id={chat}"),
        "/sessions".into(),
        "/navigation".into(),
        "/command-palette?query=canon".into(),
        format!("/projects/{project}/dashboard/history?limit=100"),
    ] {
        let reply = s.gw.get(&path).await?;
        assert_eq!(reply.status, 200, "{path}: {}", reply.text);
        assert!(
            !reply.text.contains("canon:epic/"),
            "{path}: {}",
            reply.text
        );
    }
    let events = s.gw.events_since(0).await?;
    assert!(
        !serde_json::to_string(&events)?.contains("canon:epic/"),
        "{events:?}"
    );
    s.finish().await?;
    server.abort();
    Ok(())
}
