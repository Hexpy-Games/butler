//! A large photo attachment on an Anthropic model through the real gateway.
use super::*;

/// Preview.11 regression: a phone-sized photo on an Anthropic model failed
/// `model_request_context_capacity_exceeded` before any provider call because
/// its base64 was estimated as text. It must reach the provider unchanged.
#[tokio::test]
async fn anthropic_large_photo_attachment_reaches_the_provider() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, stub, server) = start("1h", "on", true).await?;
    let photo = butler_e2e::e2e::media::noise_png(1100, 1000);
    // Over 3 MB: its base64 alone would estimate past a 1M-token window.
    assert!(
        (3_000_000..7_500_000).contains(&photo.len()),
        "fixture size {}",
        photo.len()
    );
    let upload =
        s.gw.upload("photo.png", "image/png", &photo, Some("general"))
            .await?;
    assert_eq!(upload.status, 201, "{}", upload.text);
    let accepted = s.gw.post("/messages", json!({
        "chat_id":"general", "text":"What is in this photo?",
        "attachments":[{"file_id":upload.data()["file"]["file_id"]}],
        "model":"anthropic/claude-sonnet-5", "client_message_id":uuid::Uuid::new_v4().to_string(),
    })).await?;
    assert_eq!(accepted.status, 202, "{}", accepted.text);
    let id = s.gw.accepted_turn(accepted.data()).await?;
    let turn =
        s.gw.wait_terminal("general", &id, std::time::Duration::from_secs(60))
            .await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    let requests = stub.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 2);
    for body in &requests {
        let blocks = body["messages"][0]["content"].as_array().unwrap();
        let images: Vec<_> = blocks
            .iter()
            .filter(|block| block["type"] == "image")
            .collect();
        assert_eq!(images.len(), 1);
        assert_eq!(images[0]["source"]["type"], "base64");
        assert_eq!(images[0]["source"]["media_type"], "image/png");
        let sent = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            images[0]["source"]["data"].as_str().unwrap(),
        )
        .unwrap();
        assert!(sent.len() > 3_000_000, "derivative {}", sent.len());
        let decoded = image::load_from_memory(&sent).unwrap().to_rgb8();
        let original = image::load_from_memory(&photo).unwrap().to_rgb8();
        assert!(decoded == original, "sent pixels differ from the upload");
        assert!(
            blocks
                .last()
                .unwrap()
                .get("text")
                .and_then(Value::as_str)
                .unwrap()
                .ends_with("What is in this photo?")
        );
    }
    s.finish().await?;
    server.abort();
    Ok(())
}
