//! A large photo attachment passes physical context admission on every native
//! image carrier and reaches the provider intact. Image bytes cost the shared
//! image-token allowance, never their base64 length as text.
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::*;
use crate::models::{VisualAttachmentManifest, image_admission_for_catalog_entry};
use butler_turn::btcc::{BtccError, PortFuture, VerifiedImagePayloadPort};

struct Payload(Vec<u8>);

impl VerifiedImagePayloadPort for Payload {
    fn read<'a>(&'a self, _: &'a Value) -> PortFuture<'a, Vec<u8>> {
        Box::pin(async move { Ok::<_, BtccError>(self.0.clone()) })
    }
}

/// 3 MiB of incompressible bytes: a typical phone photo. Its 4 MiB of base64
/// alone exceeds every 1M-token window when estimated as text.
fn photo() -> Vec<u8> {
    let mut state = 0x9e37_79b9_7f4a_7c15_u64;
    (0..3 * 1024 * 1024)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state.to_le_bytes()[0]
        })
        .collect()
}

fn manifest(bytes: &[u8]) -> VisualAttachmentManifest {
    VisualAttachmentManifest {
        kind: "image".into(),
        file_id: "file-photo".into(),
        position: 0,
        safe_name: "photo.jpg".into(),
        mime_type: "image/jpeg".into(),
        sniffed_mime_type: "image/jpeg".into(),
        sniffed_magic: "jpeg".into(),
        storage_revision: "storage-1".into(),
        source_size_bytes: bytes.len(),
        source_digest: "a".repeat(64),
        derivative_id: "derivative-photo".into(),
        derivative_mime_type: "image/jpeg".into(),
        derivative_size_bytes: bytes.len(),
        derivative_digest: format!("{:x}", Sha256::digest(bytes)),
        width: 3200,
        height: 2400,
        pixel_count: 3200 * 2400,
        sanitizer_revision: "sanitizer-1".into(),
        manifest_digest: "c".repeat(64),
    }
}

fn reply(model: &str) -> Vec<u8> {
    let payload = if model.starts_with("anthropic/") {
        json!({"content":[{"type":"text","text":"A photo."}],"stop_reason":"end_turn","usage":{}})
    } else if model.starts_with("google/") {
        json!({"candidates":[{"content":{"role":"model","parts":[{"text":"A photo."}]},
            "finishReason":"STOP"}]})
    } else {
        json!({"status":"completed","output":[{"type":"message","role":"assistant",
            "content":[{"type":"output_text","text":"A photo."}]}],"usage":{}})
    }
    .to_string();
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
        payload.len()
    )
    .into_bytes()
}

/// The inline image as it was sent, in each carrier's documented shape.
fn sent_image<'a>(model: &str, body: &'a Value) -> Option<(&'a str, &'a str)> {
    let pair = |mime: &'a Value, data: &'a Value| Some((mime.as_str()?, data.as_str()?));
    if model.starts_with("anthropic/") {
        let blocks = body["messages"][0]["content"].as_array()?;
        let image = blocks.iter().find(|block| block["type"] == "image")?;
        assert_eq!(image["source"]["type"], "base64");
        pair(&image["source"]["media_type"], &image["source"]["data"])
    } else if model.starts_with("google/") {
        let parts = body["contents"][0]["parts"].as_array()?;
        let image = parts.iter().find_map(|part| part.get("inline_data"))?;
        pair(&image["mime_type"], &image["data"])
    } else {
        let user = body["input"]
            .as_array()?
            .iter()
            .find(|row| row["role"] == "user")?;
        let url = user["content"]
            .as_array()?
            .iter()
            .find(|part| part["type"] == "input_image")?["image_url"]
            .as_str()?;
        Some(("image/jpeg", url.strip_prefix("data:image/jpeg;base64,")?))
    }
}

async fn large_photo_round(model: &str, bytes: &[u8]) {
    let (catalog, snapshot) = catalog();
    let metadata = snapshot.find_model_metadata(Some(model)).unwrap();
    let admitted = image_admission_for_catalog_entry(Some(&metadata), &[manifest(bytes)]).unwrap();
    let tuple = serde_json::to_value(&admitted.tuple).unwrap();
    let capability = serde_json::to_value(&admitted.capability).unwrap();
    let manifests: Vec<Value> = admitted
        .manifests
        .iter()
        .map(|manifest| serde_json::to_value(manifest).unwrap())
        .collect();
    let (endpoint, stub) = server(vec![reply(model)]).await;
    let provider = ModelProvider::new(
        crate::models::provider_http_client().unwrap(),
        Arc::new(Config {
            metadata,
            endpoint,
            snapshot,
            codex: false,
        }),
        Arc::new(Observations::default()),
        catalog,
        Arc::new(TestClock::at(1_000)),
        Arc::new(Metrics),
    );
    let messages = [ModelRoundMessage::user(
        "What is in this photo?".into(),
        None,
    )];
    let payload = Payload(bytes.to_vec());
    let mut input = request(
        model,
        &messages,
        &ReasoningEffort::None,
        CancellationToken::new(),
        None,
    );
    input.image_carrier = Some(&tuple);
    input.image_capability = Some(&capability);
    input.image_manifests = &manifests;
    input.verified_image_payload = Some(&payload);
    let result = provider.run_round(input).await;
    assert!(result.is_ok(), "{model}: {:?}", result.err());
    assert_eq!(result.unwrap().text.as_deref(), Some("A photo."), "{model}");
    let wire = stub.await.unwrap();
    let offset = wire
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .unwrap()
        + 4;
    let body: Value = serde_json::from_slice(&wire[offset..]).unwrap();
    let (mime, data) = sent_image(model, &body).unwrap_or_else(|| panic!("{model}: no image"));
    assert_eq!(mime, "image/jpeg", "{model}");
    assert_eq!(
        STANDARD.decode(data).unwrap(),
        bytes,
        "{model}: image bytes changed"
    );
}

/// Regression for preview.11: an attached photo on Anthropic (and Gemini)
/// failed `model_request_context_capacity_exceeded` before any provider call.
pub(super) async fn large_photo_attachment_is_admitted_on_every_native_carrier() {
    let bytes = photo();
    for model in [
        "anthropic/claude-opus-5-5",
        "google/gemini-3.8-flash",
        "openai/gpt-5.5",
    ] {
        large_photo_round(model, &bytes).await;
    }
}
