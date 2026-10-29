use super::*;

#[tokio::test]
async fn unknown_chat_finish_reason_fails_and_keeps_partial() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let partial = "Partial answer before the provider error.";
    let server = FakeServer::local_models(ChatBehavior {
        answer: partial.into(),
        finish_reason: "error".into(),
        ..ChatBehavior::default()
    })
    .await?;
    let s = with_local_server("CHAT-UNKNOWN-STOP", &server).await?;
    use_local_model(&s, &server.base_url).await?;
    let accepted = s.gw.say("general", "Explain the design.").await?;
    let id = s.gw.accepted_turn(&accepted).await?;
    let turn =
        s.gw.wait_terminal("general", &id, Duration::from_secs(60))
            .await?;
    assert_eq!(turn_state(&turn), "failed", "{turn}");
    assert_eq!(turn["safe_error_code"], "provider_stop_unrecognized");
    assert_eq!(turn["retryable"], true);
    let messages = s.gw.messages("general").await?;
    assert!(
        messages.iter().any(|m| m["turn_id"] == id
            && m["status"] == "cancelled"
            && m["incomplete"] == true
            && m["text"] == partial),
        "{messages:?}"
    );
    s.finish().await
}
