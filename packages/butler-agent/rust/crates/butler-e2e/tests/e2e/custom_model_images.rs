//! Custom image admission, persistence, discovery and provider failure recovery.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use super::setup_local_models::with_local_server;
use butler_e2e::e2e::fake_servers::{
    ChatBehavior, FakeServer, LOCAL_MODEL, LocalCapabilities, carries_image,
};
use butler_e2e::e2e::gateway::{Reply, turn_state};
use butler_e2e::e2e::scenario::Scenario;
use butler_e2e::e2e::{HarnessError, media};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

fn registration(server: &FakeServer, platform: &str) -> Value {
    json!({"provider_id":"local","api_type":"openai_compatible","platform":platform,
        "server_url":format!("{}/v1",server.base_url),"model_id":LOCAL_MODEL,
        "context_window_tokens":131_072,"source":"manual"})
}
async fn register(s: &Scenario, body: Value) -> Result<Value, HarnessError> {
    let reply = s.gw.post("/model-catalog/local-models", body).await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    let model = reply.data()["model"].clone();
    let settings =
        s.gw.patch(
            "/settings",
            json!({"model":model["model_ref"],"access_mode":"full_access"}),
        )
        .await?;
    assert_eq!(settings.status, 200, "{}", settings.text);
    Ok(model)
}
async fn image(s: &Scenario) -> Result<Reply, HarnessError> {
    let upload =
        s.gw.upload(
            "number.png",
            "image/png",
            &media::digits_png("4821", 12),
            Some("general"),
        )
        .await?;
    assert_eq!(upload.status, 201, "{}", upload.text);
    s.gw.post(
        "/messages",
        json!({"chat_id":"general","text":"Describe this image.",
        "attachments":[{"file_id":upload.data()["file"]["file_id"]}],
        "client_message_id":uuid::Uuid::new_v4().to_string()}),
    )
    .await
}
async fn terminal(s: &Scenario, reply: &Reply) -> Result<Value, HarnessError> {
    assert_eq!(reply.status, 202, "{}", reply.text);
    s.gw.wait_terminal(
        "general",
        &s.gw.accepted_turn(reply.data()).await?,
        Duration::from_secs(30),
    )
    .await
}
fn model(catalog: &Value) -> &Value {
    catalog["models"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["model_id"] == LOCAL_MODEL)
        .unwrap()
}
fn assert_support(model: &Value, support: &str, source: &str) {
    assert_eq!(model["image_input_support"], support, "{model}");
    assert_eq!(model["image_capability_source"], source, "{model}");
    for field in [
        "image_endpoint_profile_id",
        "image_capability_revision",
        "image_capability_digest",
        "image_capability_source_url",
        "image_capability_verified_at",
    ] {
        assert!(
            !model[field].as_str().unwrap_or_default().is_empty(),
            "{field}: {model}"
        );
    }
    assert_eq!(model["image_carrier_protocol"], "openai_chat_completions");
}
#[tokio::test]
async fn native_discovery_accepts_images_and_reaches_chat_provider() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for (platform, cap) in [
        (
            "ollama",
            LocalCapabilities {
                ollama: Some(vec!["completion".into(), "vision".into()]),
                ..Default::default()
            },
        ),
        (
            "lm_studio",
            LocalCapabilities {
                lm_studio: Some("vlm".into()),
                ..Default::default()
            },
        ),
        (
            "llama_cpp",
            LocalCapabilities {
                llama_cpp: Some(true),
                ..Default::default()
            },
        ),
        (
            "custom",
            LocalCapabilities {
                input_modalities: Some(vec!["text".into(), "image".into()]),
                ..Default::default()
            },
        ),
    ] {
        let server = FakeServer::local_models(ChatBehavior {
            local_capabilities: cap,
            ..Default::default()
        })
        .await?;
        let s = with_local_server(&format!("CUSTOM-IMAGE-{platform}"), &server).await?;
        let body = registration(&server, platform);
        let discovered =
            s.gw.post("/model-catalog/local/discover", body.clone())
                .await?;
        assert_eq!(discovered.status, 200, "{}", discovered.text);
        let models = discovered.data()["models"].as_array().unwrap();
        assert_support(&models[0], "supported", "provider_discovery");
        let registered = register(&s, body).await?;
        assert_support(&registered, "supported", "provider_discovery");
        let turn = terminal(&s, &image(&s).await?).await?;
        assert_eq!(turn_state(&turn), "delivered", "{turn}");
        assert!(
            server.chat_requests().iter().any(carries_image),
            "image never reached provider"
        );
        let catalog = s.gw.get("/model-catalog").await?;
        assert_support(model(catalog.data()), "supported", "provider_discovery");
        s.finish().await?;
    }
    Ok(())
}
#[tokio::test]
async fn declaration_patches_and_restart_preserve_auto_semantics() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let server = FakeServer::local_models(ChatBehavior::default()).await?;
    let mut s = with_local_server("CUSTOM-IMAGE-DECLARATION", &server).await?;
    let mut body = registration(&server, "custom");
    body["image_input"] = json!(true);
    assert_support(&register(&s, body.clone()).await?, "supported", "user");
    let turn = terminal(&s, &image(&s).await?).await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    assert!(server.chat_requests().iter().any(carries_image));
    body.as_object_mut().unwrap().remove("image_input");
    let path = format!("/model-catalog/local-models/{LOCAL_MODEL}");
    let reply = s.gw.patch(&path, body.clone()).await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    assert_support(&reply.data()["model"], "supported", "user");
    s.restart().await?;
    assert_support(
        model(s.gw.get("/model-catalog").await?.data()),
        "supported",
        "user",
    );
    let stored: Value =
        serde_json::from_slice(&std::fs::read(s.sandbox.data.join("butler.config.json"))?)?;
    assert_eq!(stored["models"]["local"][0]["image_input"], true);
    body["image_input"] = Value::Null;
    let reply = s.gw.patch(&path, body).await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    assert!(
        reply.data()["model"]
            .get("image_input_support")
            .is_none_or(Value::is_null)
    );
    let refused = image(&s).await?;
    assert_eq!(
        refused.error_code(),
        Some("image_capability_unknown"),
        "{}",
        refused.text
    );
    s.finish().await
}
#[tokio::test]
async fn unknown_and_explicit_unsupported_are_refused() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for (declaration, cap, code) in [
        (None, None, "image_capability_unknown"),
        (
            Some(false),
            Some(vec!["vision".into()]),
            "image_model_unsupported",
        ),
        (
            None,
            Some(vec!["completion".into()]),
            "image_model_unsupported",
        ),
    ] {
        let server = FakeServer::local_models(ChatBehavior {
            local_capabilities: LocalCapabilities {
                ollama: cap,
                ..Default::default()
            },
            ..Default::default()
        })
        .await?;
        let s = with_local_server(&format!("CUSTOM-IMAGE-{code}-{declaration:?}"), &server).await?;
        let mut body = registration(&server, "ollama");
        if let Some(value) = declaration {
            body["image_input"] = json!(value);
        }
        register(&s, body).await?;
        let reply = image(&s).await?;
        assert_eq!(reply.error_code(), Some(code), "{}", reply.text);
        assert_eq!(server.chat_requests(), [] as [Value; 0]);
        s.finish().await?;
    }
    Ok(())
}
#[tokio::test]
async fn invalid_declaration_and_forged_discovery_are_rejected() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let server = FakeServer::local_models(ChatBehavior::default()).await?;
    let s = with_local_server("CUSTOM-IMAGE-VALIDATION", &server).await?;
    for value in [json!("true"), json!(1), json!([]), json!({})] {
        let mut body = registration(&server, "custom");
        body["image_input"] = value;
        let reply = s.gw.post("/model-catalog/local-models", body).await?;
        assert_eq!(reply.status, 400, "{}", reply.text);
    }
    let mut body = registration(&server, "custom");
    body["image_discovery"] = json!({"supported":true,"verified_at":"2026-10-19T00:00:00Z"});
    let reply = s.gw.post("/model-catalog/local-models", body).await?;
    assert_eq!(reply.status, 400, "{}", reply.text);
    s.finish().await
}
#[tokio::test]
async fn startup_discovers_once_and_persists_without_polling() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let server = FakeServer::local_models(ChatBehavior {
        local_capabilities: LocalCapabilities {
            ollama: Some(vec!["vision".into()]),
            ..Default::default()
        },
        ..Default::default()
    })
    .await?;
    let mut s = with_local_server("CUSTOM-IMAGE-STARTUP", &server).await?;
    register(&s, registration(&server, "ollama")).await?;
    s.agent.terminate().await?;
    let path = s.sandbox.data.join("butler.config.json");
    let mut config: Value = serde_json::from_slice(&std::fs::read(&path)?)?;
    config["models"]["local"][0]
        .as_object_mut()
        .unwrap()
        .remove("image_discovery");
    std::fs::write(&path, serde_json::to_vec(&config)?)?;
    let before = server
        .seen()
        .iter()
        .filter(|r| r.path == "/api/show")
        .count();
    let started = Instant::now();
    s.restart().await?;
    loop {
        let reply = s.gw.get("/model-catalog").await?;
        if model(reply.data())["image_input_support"] == "supported" {
            break;
        }
        butler_e2e::assert_wall_clock_budget!(
            started.elapsed(),
            Duration::from_secs(10),
            "startup discovery did not finish"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    eprintln!(
        "startup discovery including restart: {:?}",
        started.elapsed()
    );
    assert_eq!(
        server
            .seen()
            .iter()
            .filter(|r| r.path == "/api/show")
            .count(),
        before + 1
    );
    s.restart().await?;
    for _ in 0..3 {
        s.gw.get("/model-catalog").await?;
    }
    assert_eq!(
        server
            .seen()
            .iter()
            .filter(|r| r.path == "/api/show")
            .count(),
        before + 1
    );
    s.finish().await
}
#[tokio::test]
async fn provider_image_400_followup_text_is_delivered() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let server = FakeServer::local_models(ChatBehavior {
        refuse_images: Some(json!({"error":{"message":"Image input is not supported",
            "type":"invalid_request_error","code":"unsupported_image"}})),
        ..Default::default()
    })
    .await?;
    let s = with_local_server("CUSTOM-IMAGE-PROVIDER-400", &server).await?;
    let mut body = registration(&server, "custom");
    body["image_input"] = json!(true);
    register(&s, body).await?;
    let turn = terminal(&s, &image(&s).await?).await?;
    assert_eq!(turn_state(&turn), "failed", "{turn}");
    assert!(server.chat_requests().iter().any(carries_image));
    let before = server.chat_requests().len();
    let (_, followup) = s.turn("general", "Reply with text please.").await?;
    let requests = server.chat_requests();
    eprintln!(
        "provider image 400: failed_turn={turn}; followup={followup}; followup_requests={}",
        json!(&requests[before..])
    );
    assert_eq!(
        turn_state(&followup),
        "delivered",
        "followup={followup}; requests={}",
        json!(&requests[before..])
    );
    s.finish().await
}

#[tokio::test]
async fn display_name_edit_preserves_discovery_when_probe_has_no_result() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let server = FakeServer::local_models(ChatBehavior {
        local_capabilities: LocalCapabilities {
            ollama: Some(vec!["vision".into()]),
            ..Default::default()
        },
        ..Default::default()
    })
    .await?;
    let s = with_local_server("CUSTOM-IMAGE-RENAME", &server).await?;
    let mut body = registration(&server, "ollama");
    assert_support(
        &register(&s, body.clone()).await?,
        "supported",
        "provider_discovery",
    );
    server.set_local_capabilities(LocalCapabilities::default());
    body["display_name"] = json!("Renamed model");
    let reply =
        s.gw.patch(&format!("/model-catalog/local-models/{LOCAL_MODEL}"), body)
            .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    assert_eq!(reply.data()["model"]["display_name"], "Renamed model");
    assert_support(&reply.data()["model"], "supported", "provider_discovery");
    assert_support(
        model(s.gw.get("/model-catalog").await?.data()),
        "supported",
        "provider_discovery",
    );
    let turn = terminal(&s, &image(&s).await?).await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    assert!(server.chat_requests().iter().any(carries_image));
    s.finish().await
}

#[tokio::test]
async fn model_id_edit_clears_discovery_when_probe_has_no_result() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let server = FakeServer::local_models(ChatBehavior {
        local_capabilities: LocalCapabilities {
            ollama: Some(vec!["vision".into()]),
            ..Default::default()
        },
        ..Default::default()
    })
    .await?;
    let s = with_local_server("CUSTOM-IMAGE-CHANGE-ID", &server).await?;
    let mut body = registration(&server, "ollama");
    assert_support(
        &register(&s, body.clone()).await?,
        "supported",
        "provider_discovery",
    );
    server.set_local_capabilities(LocalCapabilities::default());
    body["model_id"] = json!("different-model");
    let reply =
        s.gw.patch(&format!("/model-catalog/local-models/{LOCAL_MODEL}"), body)
            .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    let updated = &reply.data()["model"];
    assert_eq!(updated["model_id"], "different-model");
    assert!(
        updated
            .get("image_input_support")
            .is_none_or(Value::is_null),
        "{updated}"
    );
    assert!(
        updated
            .get("image_capability_source")
            .is_none_or(Value::is_null),
        "{updated}"
    );
    let settings =
        s.gw.patch("/settings", json!({"model":updated["model_ref"]}))
            .await?;
    assert_eq!(settings.status, 200, "{}", settings.text);
    let refused = image(&s).await?;
    assert_eq!(refused.status, 409, "{}", refused.text);
    assert_eq!(
        refused.error_code(),
        Some("image_capability_unknown"),
        "{}",
        refused.text
    );
    assert_eq!(server.chat_requests(), [] as [Value; 0]);
    let stored: Value =
        serde_json::from_slice(&std::fs::read(s.sandbox.data.join("butler.config.json"))?)?;
    assert!(stored["models"]["local"][0]["image_discovery"].is_null());
    s.finish().await
}
