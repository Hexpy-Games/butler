//! Browser capture contract through upload, durable send and both provider wires.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "E2E assertions")]
use butler_e2e::e2e::{
    HarnessError,
    fake_servers::{ChatBehavior, FakeServer, LOCAL_MODEL},
    gateway::turn_state,
    provider::Script,
    scenario::{Scenario, Setup},
};
use serde_json::{Value, json};
use std::time::Duration;

async fn capture(s: &Scenario) -> Result<(String, Vec<u8>, Value), HarnessError> {
    let png = super::super::image_only::proof::upload_png();
    let upload =
        s.gw.upload("selection.png", "image/png", &png, Some("general"))
            .await?;
    assert_eq!(upload.status, 201, "{}", upload.text);
    let id = upload.data()["file"]["file_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let metadata = json!({"untrusted_content":{
        "kind":"untrusted_web_page_data", "url":"https://example.org/picture",
        "selector":"figure img", "title":"Selected picture", "text":"Page caption",
        "rect":{"x":12,"y":24,"width":200,"height":120}, "capturedAt":"2026-11-02T00:00:00Z"
    }});
    Ok((id, png, metadata))
}
async fn send(s: &Scenario, id: &str, metadata: &Value) -> Result<Value, HarnessError> {
    let response = s.gw.post("/messages", json!({
        "chat_id":"general", "text":"Describe the selected picture.",
        "client_message_id":uuid::Uuid::new_v4().to_string(),
        "attachments":[{"file_id":id}],
        "content_parts":{"version":1,"parts":[{"type":"text","text":"Describe the selected picture."}],
            "attachment_metadata":{id:metadata}}
    })).await?;
    assert_eq!(response.status, 202, "{}", response.text);
    let turn = s.gw.accepted_turn(response.data()).await?;
    let terminal =
        s.gw.wait_terminal("general", &turn, Duration::from_secs(30))
            .await?;
    assert_eq!(turn_state(&terminal), "delivered", "{terminal}");
    let messages = s.gw.messages("general").await?;
    let user = messages
        .iter()
        .find(|m| m["role"] == "user")
        .expect("stored capture");
    assert_eq!(user["attachments"].as_array().unwrap().len(), 1);
    assert_eq!(user["attachments"][0]["file_id"], id);
    assert_eq!(user["attachments"][0]["kind"], "image");
    assert_eq!(user["attachments"][0]["mime_type"], "image/png");
    assert_eq!(user["content_parts"]["attachment_metadata"][id], *metadata);
    Ok(user.clone())
}
fn assert_wire(request: &Value, png: &[u8], metadata: &Value, wire: &str) {
    super::super::image_only::proof::assert_uploaded_image(request, png);
    let body = serde_json::to_string(request).unwrap();
    assert!(body.contains(wire), "missing {wire}");
    let text = request.to_string();
    // Metadata is present as quoted text, with every original field retained.
    for value in [
        "Selected picture",
        "figure img",
        "Page caption",
        "untrusted_web_page_data",
        "https://example.org/picture",
    ] {
        assert!(text.contains(value), "missing {value}: {metadata}");
    }
    assert!(text.contains("not instructions"));
}
#[tokio::test]
async fn capture_reaches_responses_as_image_with_source_metadata() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("CAPTURE-RESPONSES")?
        .synthetic(Script {
            rounds: 0,
            path_for: Box::new(|_| String::new()),
            final_text: "Snapshot received.".into(),
        })
        .start()
        .await?;
    let (id, png, metadata) = capture(&s).await?;
    send(&s, &id, &metadata).await?;
    let requests = s.provider()?.requests();
    assert_eq!(
        requests.len(),
        1,
        "no tools are needed to retrieve the capture"
    );
    assert_wire(&requests[0], &png, &metadata, "input_image");
    s.finish().await
}
#[tokio::test]
async fn capture_reaches_chat_completions_as_image_with_source_metadata() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let server = FakeServer::local_models(ChatBehavior::default()).await?;
    let s = super::super::setup_local_models::with_local_server("CAPTURE-CHAT", &server).await?;
    let registered =
        s.gw.post(
            "/model-catalog/local-models",
            json!({
                "provider_id":"local","api_type":"openai_compatible","platform":"custom",
                "server_url":format!("{}/v1", server.base_url),"model_id":LOCAL_MODEL,
                "context_window_tokens":131_072,"source":"manual","image_input":true
            }),
        )
        .await?;
    assert_eq!(registered.status, 201, "{}", registered.text);
    let settings =
        s.gw.patch(
            "/settings",
            json!({"model":registered.data()["model"]["model_ref"]}),
        )
        .await?;
    assert_eq!(settings.status, 200, "{}", settings.text);
    let (id, png, metadata) = capture(&s).await?;
    send(&s, &id, &metadata).await?;
    let requests = server.chat_requests();
    let request = requests
        .iter()
        .find(|r| r.to_string().contains("image_url"))
        .expect("image request");
    assert_wire(request, &png, &metadata, "image_url");
    s.finish().await
}
