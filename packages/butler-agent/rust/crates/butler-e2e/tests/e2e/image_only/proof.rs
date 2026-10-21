//! Shared wire evidence for stub and live image delivery.
use base64::{Engine, engine::general_purpose::STANDARD};
use butler_e2e::e2e::{HarnessError, media, scenario::Scenario};
use image::{
    ImageEncoder,
    codecs::png::{CompressionType, FilterType, PngEncoder},
};
use serde_json::Value;
use std::time::Duration;

/// A metadata-free RGBA PNG already in the sanitizer's canonical encoding.
/// Admission can re-encode it while preserving byte-exact upload identity.
pub(crate) fn upload_png() -> Vec<u8> {
    let pixels = image::load_from_memory(&media::digits_png("4821", 12))
        .unwrap()
        .into_rgba8();
    let mut bytes = Vec::new();
    PngEncoder::new_with_quality(&mut bytes, CompressionType::Best, FilterType::Adaptive)
        .write_image(
            pixels.as_raw(),
            pixels.width(),
            pixels.height(),
            image::ColorType::Rgba8.into(),
        )
        .unwrap();
    bytes
}

pub(crate) fn assert_uploaded_image(request: &Value, uploaded: &[u8]) {
    assert!(
        contains_image(request, uploaded),
        "provider request lost or changed uploaded image bytes"
    );
}

fn contains_image(value: &Value, uploaded: &[u8]) -> bool {
    // Shapes emitted by butler-models provider/visual.rs::image_part.
    if value["inline_data"]["mime_type"]
        .as_str()
        .is_some_and(|mime| mime.starts_with("image/"))
    {
        return matches_bytes(&value["inline_data"]["data"], uploaded);
    }
    let encoded = match value["type"].as_str() {
        Some("input_image") => value["image_url"].as_str(),
        Some("image_url") => value["image_url"]["url"].as_str(),
        Some("image") if value["source"]["type"] == "base64" => {
            return matches_bytes(&value["source"]["data"], uploaded);
        }
        _ => None,
    };
    if let Some(encoded) = encoded.and_then(|s| s.strip_prefix("data:image/")) {
        return encoded
            .split_once(";base64,")
            .and_then(|(_, data)| STANDARD.decode(data).ok())
            .is_some_and(|bytes| bytes == uploaded);
    }
    match value {
        Value::Array(items) => items.iter().any(|v| contains_image(v, uploaded)),
        Value::Object(items) => items.values().any(|v| contains_image(v, uploaded)),
        _ => false,
    }
}

fn matches_bytes(encoded: &Value, uploaded: &[u8]) -> bool {
    encoded
        .as_str()
        .and_then(|s| STANDARD.decode(s).ok())
        .is_some_and(|bytes| bytes == uploaded)
}

/// Read the final successful attempt, scoped to the delivered turn.
pub(crate) async fn provider_body(s: &Scenario, turn: &str) -> Result<Value, HarnessError> {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let logs =
                s.gw.get(&format!("/logs?turn_id={turn}&limit=1000"))
                    .await?;
            assert_eq!(logs.status, 200);
            let mut rows: Vec<_> = logs.data()["rows"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|r| {
                    r["event"] == "http.request"
                        && r["attrs"]["phase"] == "parent"
                        && r["category"]
                            .as_str()
                            .is_some_and(|c| c.starts_with("provider."))
                })
                .collect();
            rows.sort_by_key(|r| r["ts"].as_str().unwrap_or_default());
            if !rows.is_empty() {
                let row = final_successful_attempt(&rows);
                assert_eq!(row["turn_id"], turn);
                let body = if let Some(reference) = row["body_ref"].as_str() {
                    let reply = s.gw.get(&format!("/logs/bodies/{reference}")).await?;
                    assert_eq!(reply.status, 200);
                    reply.body
                } else {
                    row["content"].clone()
                };
                assert!(body["request"].is_object(), "missing full request body");
                return Ok::<_, HarnessError>(body);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("provider HTTP log missing")
}

fn final_successful_attempt<'a>(rows: &[&'a Value]) -> &'a Value {
    let last = rows.last().expect("provider attempts");
    assert!(
        !last["attrs"]["status"]
            .as_u64()
            .is_some_and(|status| (400..500).contains(&status)),
        "provider ended with a non-retried 4xx"
    );
    rows.iter()
        .rev()
        .copied()
        .find(|row| {
            row["attrs"]["status"]
                .as_u64()
                .is_some_and(|status| (200..300).contains(&status))
                && row["error"].is_null()
        })
        .expect("no provider attempt succeeded")
}

fn response_events(body: &Value) -> Vec<Value> {
    if body["response"].is_object() {
        return vec![body["response"].clone()];
    }
    let response = body["response"].as_str().expect("full provider response");
    if let Ok(value) = serde_json::from_str(response) {
        return vec![value];
    }
    let events: Vec<Value> = response
        .lines()
        .filter_map(|line| {
            let data = line.strip_prefix("data:")?.trim();
            if data == "[DONE]" {
                return None;
            }
            Some(serde_json::from_str(data).expect("provider SSE JSON"))
        })
        .collect();
    assert!(!events.is_empty(), "no provider response events");
    events
}

pub(crate) fn assert_response_ok(body: &Value) {
    let events = response_events(body);
    for event in &events {
        assert_no_error(event);
    }
    // Providers end their protocol before the adapter drops the HTTP stream;
    // the logger's response_complete flag tracks EOF, not model completion.
    assert!(
        events.iter().any(|event| {
            matches!(
                event["type"].as_str(),
                Some("response.completed" | "message_stop")
            ) || event["status"] == "completed"
                || event["choices"].as_array().is_some_and(|choices| {
                    choices
                        .iter()
                        .any(|choice| choice["finish_reason"].is_string())
                })
                || event["candidates"].as_array().is_some_and(|candidates| {
                    candidates
                        .iter()
                        .any(|candidate| candidate["finishReason"].is_string())
                })
        }),
        "provider response has no protocol completion"
    );
}

fn assert_no_error(value: &Value) {
    match value {
        Value::Array(items) => items.iter().for_each(assert_no_error),
        Value::Object(items) => {
            assert!(
                items.get("error").is_none_or(Value::is_null),
                "provider response error"
            );
            assert!(
                !matches!(
                    value["type"].as_str(),
                    Some("error" | "response.failed" | "response.incomplete")
                ),
                "provider failed or incomplete response"
            );
            items.values().for_each(assert_no_error);
        }
        _ => {}
    }
}

fn usage(body: &Value) -> Option<Value> {
    response_events(body).iter().rev().find_map(find_usage)
}

fn find_usage(value: &Value) -> Option<Value> {
    for key in ["usage", "usageMetadata"] {
        if value[key].is_object() {
            return Some(value[key].clone());
        }
    }
    match value {
        Value::Object(items) => items.values().find_map(find_usage),
        Value::Array(items) => items.iter().find_map(find_usage),
        _ => None,
    }
}

pub(crate) fn assert_image_usage(baseline: &Value, image: &Value) {
    let Some(image) = usage(image) else {
        return;
    };
    if let Some(tokens) = image_tokens(&image) {
        assert!(tokens > 0, "provider reported zero image tokens");
        return;
    }
    let input_tokens = |u: &Value| {
        u["input_tokens"]
            .as_u64()
            .or_else(|| u["prompt_tokens"].as_u64())
            .or_else(|| u["promptTokenCount"].as_u64())
    };
    if let Some(tokens) = input_tokens(&image) {
        let baseline = usage(baseline)
            .as_ref()
            .and_then(input_tokens)
            .expect("provider reported image input tokens but no text-only baseline usage");
        eprintln!("image usage: text-only={baseline}, with-image={tokens}");
        assert!(
            tokens > baseline,
            "image input was not counted above text-only baseline"
        );
    }
}

// Explicit image accounting takes precedence over aggregate prompt deltas.
fn image_tokens(usage: &Value) -> Option<u64> {
    for path in [
        "/input_tokens_details/image_tokens",
        "/prompt_tokens_details/image_tokens",
    ] {
        if let Some(tokens) = usage.pointer(path).and_then(Value::as_u64) {
            return Some(tokens);
        }
    }
    let details = usage["promptTokensDetails"].as_array()?;
    let tokens: Vec<_> = details
        .iter()
        .filter(|detail| detail["modality"] == "IMAGE")
        .filter_map(|detail| detail["tokenCount"].as_u64())
        .collect();
    (!tokens.is_empty()).then(|| tokens.iter().sum())
}

mod tests;
