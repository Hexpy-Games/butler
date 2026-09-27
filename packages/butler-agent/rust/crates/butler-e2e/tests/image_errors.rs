//! ATT-02 — image refusals are worded in the App's language.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::media;
use butler_e2e::e2e::scenario::Setup;
use serde_json::json;

/// ATT-02 — a PNG sent to a model whose catalog entry has no image input is
/// refused before any model call with `image_model_unsupported`, and the
/// message follows the Settings language (English, then Korean).
#[tokio::test]
async fn att_02_image_refusal_follows_the_app_language() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("ATT-02-LOCALE")?.start().await?;
    for (language, expected) in [
        ("en", "can't read images"),
        ("ko", "이미지를 읽을 수 없습니다"),
    ] {
        let reply =
            s.gw.patch("/settings", json!({"language": language}))
                .await?;
        assert_eq!(reply.status, 200, "{}", reply.text);
        let png = media::digits_png("4821", 12);
        let upload =
            s.gw.upload("number.png", "image/png", &png, Some("general"))
                .await?;
        assert_eq!(upload.status, 201, "{}", upload.text);
        let file_id = upload.data()["file"]["file_id"]
            .as_str()
            .unwrap()
            .to_owned();
        let reply =
            s.gw.post(
                "/messages",
                json!({"chat_id": "general", "text": "What number is this?",
                    "attachments": [{"file_id": file_id}], "model": "qwen/qwen3.7-max",
                    "client_message_id": uuid::Uuid::new_v4().to_string()}),
            )
            .await?;
        assert_eq!(reply.status, 409, "{language}: {}", reply.text);
        assert_eq!(
            reply.error_code(),
            Some("image_model_unsupported"),
            "{language}: {}",
            reply.text
        );
        let message = reply.body["error"]["message"].as_str().unwrap_or_default();
        assert!(
            message.contains(expected),
            "{language}: refusal not in the App language: {message}"
        );
    }
    s.finish().await
}
