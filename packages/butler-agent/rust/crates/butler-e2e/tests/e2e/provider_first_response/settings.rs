//! A Custom model's own response time limit: applied to its rounds and
//! kept through the settings API.
use super::*;

/// The registration body for the server's model, with `timeout`.
fn registration(server: &FakeServer, timeout: Option<Value>) -> Value {
    let mut body = json!({
        "provider_id": "local", "api_type": "openai_compatible", "platform": "ollama",
        "server_url": server.base_url, "model_id": LOCAL_MODEL,
        "context_window_tokens": 131_072, "source": "discovered"
    });
    if let Some(timeout) = timeout {
        body["response_timeout_ms"] = timeout;
    }
    body
}

/// Saves the model's limit and returns the saved model.
async fn save_timeout(
    s: &Scenario,
    server: &FakeServer,
    timeout: Value,
) -> Result<Value, HarnessError> {
    let path = format!("/model-catalog/local-models/{LOCAL_MODEL}");
    let reply =
        s.gw.patch(&path, registration(server, Some(timeout)))
            .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    Ok(reply.data()["model"].clone())
}

/// The model's own limit replaces the global total for its rounds.
#[tokio::test]
async fn custom_model_timeout_replaces_global_total() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let pace = Pace::FirstByteAfter(Duration::from_millis(3_000));
    let (server, s) = paced("FIRST-RESPONSE-05", pace, 1_500).await?;
    // The default the form shows follows the global override.
    let catalog = s.gw.get("/model-catalog").await?;
    assert_eq!(catalog.data()["response_timeout"]["default_ms"], 1_500);
    let ended = timed_turn(&s, "First question.").await?;
    eprintln!(
        "FIRST-RESPONSE-05 global: {} after {:?}",
        turn_state(&ended.turn),
        ended.elapsed
    );
    assert_eq!(ended.turn["safe_error_code"], FIRST_RESPONSE_TIMEOUT);
    let model = save_timeout(&s, &server, json!(8_000)).await?;
    assert_eq!(model["response_timeout_ms"], 8_000, "{model}");
    let ended = timed_turn(&s, "Second question.").await?;
    eprintln!(
        "FIRST-RESPONSE-05 model: {} after {:?}",
        turn_state(&ended.turn),
        ended.elapsed
    );
    assert_eq!(turn_state(&ended.turn), "delivered", "{}", ended.turn);
    assert_eq!(ended.text, ChatBehavior::default().answer);
    assert_eq!(rounds(&server), 2, "one request per turn");
    s.finish().await
}

/// The limit round-trips through the settings API: saved, kept when a save
/// leaves it out, cleared by null, and out-of-range values are refused.
#[tokio::test]
async fn response_timeout_round_trips_through_settings() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let server = FakeServer::local_models(ChatBehavior::default()).await?;
    let s = with_local_server("FIRST-RESPONSE-06", &server).await?;
    let created =
        s.gw.post(
            "/model-catalog/local-models",
            registration(&server, Some(json!(900_000))),
        )
        .await?;
    assert_eq!(created.status, 201, "{}", created.text);
    assert_eq!(created.data()["model"]["response_timeout_ms"], 900_000);
    let catalog = s.gw.get("/model-catalog").await?;
    // The form's hint and range come from the runtime's own policy.
    assert_eq!(
        catalog.data()["response_timeout"],
        json!({"default_ms": 600_000, "min_ms": 1_000, "max_ms": 86_400_000})
    );
    let listed = catalog.data()["models"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["model_id"] == LOCAL_MODEL);
    assert_eq!(listed.unwrap()["response_timeout_ms"], 900_000);
    let stored: Value =
        serde_json::from_slice(&std::fs::read(s.sandbox.data.join("butler.config.json"))?)?;
    assert_eq!(stored["models"]["local"][0]["response_timeout_ms"], 900_000);
    let path = format!("/model-catalog/local-models/{LOCAL_MODEL}");
    let kept = s.gw.patch(&path, registration(&server, None)).await?;
    let kept_model = &kept.data()["model"];
    assert_eq!(kept_model["response_timeout_ms"], 900_000, "{}", kept.text);
    let max = save_timeout(&s, &server, json!(86_400_000)).await?;
    assert_eq!(max["response_timeout_ms"], 86_400_000);
    for invalid in [
        json!(0),
        json!(999),
        json!(1_500.5),
        json!(86_400_001),
        json!("600000"),
    ] {
        let body = registration(&server, Some(invalid.clone()));
        let refused = s.gw.patch(&path, body).await?;
        assert_eq!(refused.status, 400, "{invalid}: {}", refused.text);
    }
    let cleared = save_timeout(&s, &server, Value::Null).await?;
    assert!(cleared.get("response_timeout_ms").is_none(), "{cleared}");
    s.finish().await
}
