//! First-message metadata remains available before the executor's initial poll.
use super::*;

#[tokio::test]
async fn startup_refusal_leaves_no_queued_input_and_ready_chat_gets_title()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, prompt) = start("TITLE-STARTUP").await?;
    s.agent.launch.set_env("BUTLER_E2E_TIER", "stub");
    s.agent
        .launch
        .set_env("BUTLER_E2E_HOLD_DISPATCH_READY", "1");
    s.restart().await?;
    let deadline = Instant::now() + Duration::from_secs(10);
    while !s.sandbox.data.join("e2e-dispatch-ready-held").exists() {
        assert!(
            Instant::now() < deadline,
            "initial poll never reached the barrier"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let early_chat = chat(&s, &provisional(&prompt), &prompt).await?;
    let refused =
        s.gw.post(
            "/messages",
            json!({"chat_id":early_chat, "text":prompt,
        "client_message_id":uuid::Uuid::new_v4().to_string()}),
        )
        .await?;
    assert_eq!(refused.status, 503, "{refused:?}");
    let queue =
        s.gw.get(&format!("/session-queue?chat_id={early_chat}"))
            .await?;
    assert!(
        queue.data()["queued_messages"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["state"] != "queued"),
        "{queue:?}"
    );
    tokio::fs::write(
        s.sandbox.data.join("e2e-dispatch-ready-release"),
        b"release",
    )
    .await?;
    butler_e2e::e2e::readiness::wait_ready(&s.sandbox.data, &s.gw, Duration::from_secs(10), |_| {
        true
    })
    .await?;
    let chat = chat(&s, &provisional(&prompt), &prompt).await?;
    let sent = s.gw.say(&chat, &prompt).await?;
    let id = s.gw.accepted_turn(&sent).await?;
    assert!(sent["queued"].is_null(), "{sent}");
    wait_title(&s, &chat, TITLE).await?;
    let turn =
        s.gw.wait_terminal(&chat, &id, Duration::from_secs(10))
            .await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    assert_eq!(s.gw.turns(&chat).await?.len(), 1);
    s.finish().await
}
