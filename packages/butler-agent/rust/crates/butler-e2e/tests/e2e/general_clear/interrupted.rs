//! A reply cut short by an app quit is history, not pending work: General clears
//! and the archived failure stays final.
use butler_e2e::e2e::fake_servers::{ChatBehavior, FakeServer, LOCAL_MODEL};
use butler_e2e::e2e::scenario::{Fixture, Setup, accepted_turn_id};
use butler_e2e::e2e::{HarnessError, fixtures};
use serde_json::json;
use std::time::{Duration, Instant};

#[tokio::test]
async fn general_clears_after_app_quit_interrupted_a_reply() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let server = FakeServer::local_models(ChatBehavior {
        hold_later_streams: Duration::from_secs(5),
        ..ChatBehavior::default()
    })
    .await?;
    let setup = Setup::new("GENERAL-CLEAR-INTERRUPTED")?
        .fixture(Fixture::Empty)
        .env("BUTLER_OLLAMA_BASE_URL", server.base_url.clone());
    fixtures::onboarding_complete(&setup.sandbox.data)?;
    fixtures::scheduler_ran_today(&setup.sandbox.data, fixtures::FIXTURE_TIME)?;
    let mut s = setup.start().await?;
    let model =
        s.gw.post(
            "/model-catalog/local-models",
            json!({
                "provider_id":"local", "api_type":"openai_compatible", "platform":"ollama",
                "server_url":server.base_url, "model_id":LOCAL_MODEL, "display_name":LOCAL_MODEL,
                "context_window_tokens":131_072, "source":"discovered"
            }),
        )
        .await?;
    assert_eq!(model.status, 201, "{}", model.text);
    let settings =
        s.gw.patch(
            "/settings",
            json!({"model":model.data()["model"]["model_ref"]}),
        )
        .await?;
    assert_eq!(settings.status, 200, "{}", settings.text);
    let first = accepted_turn_id(&s.gw.say("general", "Hello there.").await?)?;
    s.gw.wait_terminal("general", &first, Duration::from_secs(30))
        .await?;
    let served = server.chat_requests().len();
    let cut_text = "Tell me more.";
    let cut = accepted_turn_id(&s.gw.say("general", cut_text).await?)?;
    let deadline = Instant::now() + Duration::from_secs(20);
    // Background memory rounds share the server; wait for this reply's request.
    while !server.chat_requests().iter().skip(served).any(|request| {
        request["stream"] == true
            && butler_e2e::e2e::matching::key("/v1/chat/completions", request, &Default::default())
                .user_request
                == cut_text
    }) {
        assert!(Instant::now() < deadline, "reply never reached the model");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    s.crash_and_restart().await?;
    s.gw.wait_terminal("general", &cut, Duration::from_secs(30))
        .await?;
    assert!(s.gw.messages("general").await?.len() >= 3);
    let cleared =
        s.gw.post("/sessions/general/clear", json!({"title":"Interrupted"}))
            .await?;
    assert_eq!(cleared.status, 200, "{}", cleared.text);
    let archive = cleared.data()["archived_session"]["id"]
        .as_str()
        .expect("archived session id")
        .to_owned();
    assert_eq!(
        s.gw.messages("general").await?,
        [] as [serde_json::Value; 0]
    );
    assert!(s.gw.messages(&archive).await?.len() >= 3);
    let fresh = accepted_turn_id(&s.gw.say("general", "A fresh start.").await?)?;
    s.gw.wait_terminal("general", &fresh, Duration::from_secs(30))
        .await?;
    let messages = s.gw.messages("general").await?;
    assert_eq!(messages.len(), 2, "{messages:?}");
    assert_eq!(messages[0]["text"], "A fresh start.");
    let reply = s.gw.messages(&archive).await?;
    let failed = reply
        .iter()
        .find(|m| m["turn_id"] == cut.as_str() && m["role"] == "assistant");
    assert_ne!(failed.expect("archived failed reply")["retryable"], true);
    let retried = s.gw.post(&format!("/turns/{cut}/retry"), json!({})).await?;
    assert_eq!(retried.status, 409, "{}", retried.text);
    assert_eq!(s.gw.messages("general").await?.len(), 2);
    s.finish().await
}
