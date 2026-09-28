use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::Value;
use sha2::{Digest, Sha256};

use butler_turn::btcc::{ModelRoundError, ModelRoundRequest};

use super::serialize::Carrier;

/// Validate against this physical request's resolved catalog snapshot before
/// reading any pixels or constructing the provider body.
pub(super) fn validate(
    request: &ModelRoundRequest<'_>,
    metadata: &crate::models::ModelProviderMetadata,
) -> Result<(), ModelRoundError> {
    use crate::models::{
        ImageCapabilityEvidence, ImageCarrierTuple, VisualAttachmentManifest,
        admit_visual_image_request, assert_visual_carrier_matches_catalog,
    };
    if request.image_manifests.is_empty() {
        return Ok(());
    }
    let (Some(tuple), Some(capability)) = (request.image_carrier, request.image_capability) else {
        return Err(image_error(
            "image_carrier_unverified",
            "frozen_admission_missing",
        ));
    };
    let tuple: ImageCarrierTuple = serde_json::from_value(tuple.clone())
        .map_err(|_| image_error("image_carrier_unverified", "tuple_or_evidence_missing"))?;
    let capability: ImageCapabilityEvidence = serde_json::from_value(capability.clone())
        .map_err(|_| image_error("image_carrier_unverified", "tuple_or_evidence_missing"))?;
    let route = ImageCarrierTuple {
        provider_id: metadata.provider_id.clone(),
        model_id: metadata.model_id.clone(),
        carrier_protocol: metadata
            .image_carrier_protocol
            .clone()
            .unwrap_or_else(|| "fake_vision".into()),
        endpoint_profile_id: metadata
            .image_endpoint_profile_id
            .clone()
            .unwrap_or_default(),
        catalog_capability_revision: metadata
            .image_capability_revision
            .clone()
            .unwrap_or_default(),
        catalog_capability_digest: metadata.image_capability_digest.clone().unwrap_or_default(),
    };
    assert_visual_carrier_matches_catalog(Some(metadata), &tuple, &capability, &route)
        .map_err(|error| image_error(error.code, &error.message))?;
    let manifests = request
        .image_manifests
        .iter()
        .map(|manifest| {
            serde_json::from_value::<VisualAttachmentManifest>(manifest.clone())
                .map_err(|_| image_error("image_manifest_invalid", "manifest_shape_invalid"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    admit_visual_image_request(tuple, capability, &manifests)
        .map_err(|error| image_error(error.code, &error.message))?;
    Ok(())
}

pub(super) async fn apply(
    body: &mut Value,
    request: &ModelRoundRequest<'_>,
    carrier: Carrier,
) -> Result<(), ModelRoundError> {
    if request.image_manifests.is_empty() {
        return Ok(());
    }
    let protocol = request
        .image_carrier
        .and_then(|value| {
            value
                .get("carrierProtocol")
                .or_else(|| value.get("carrier_protocol"))
        })
        .and_then(Value::as_str)
        .unwrap_or("");
    if protocol == "zai_mcp_vision" {
        let prompt = first_user_text(request);
        replace_first_user(
            body,
            carrier,
            Value::String(zai_prompt(prompt, request.image_manifests)),
        );
        return Ok(());
    }
    let expected = match carrier {
        Carrier::Responses => "openai_responses",
        Carrier::Chat { .. } => "openai_chat_completions",
        Carrier::Anthropic => "anthropic_messages",
        Carrier::Gemini => "gemini_generate_content",
    };
    if protocol != expected {
        return Err(image_error(
            "image_route_incompatible",
            "carrier_protocol_mismatch",
        ));
    }
    let payload = request.verified_image_payload.ok_or_else(|| {
        image_error(
            "image_payload_invalid",
            "verified_image_payload_port_missing",
        )
    })?;
    let mut manifests = request.image_manifests.iter().collect::<Vec<_>>();
    manifests.sort_by(|left, right| number(left, "position").total_cmp(&number(right, "position")));
    let text = first_user_text(request);
    let mut images = Vec::new();
    for manifest in manifests {
        let bytes = payload
            .read(manifest)
            .await
            .map_err(|error| image_error("image_payload_invalid", error.code()))?;
        let expected_size = manifest.get("derivativeSizeBytes").and_then(Value::as_u64);
        let mime = manifest
            .get("derivativeMimeType")
            .and_then(Value::as_str)
            .unwrap_or("");
        let digest = manifest
            .get("derivativeDigest")
            .and_then(Value::as_str)
            .unwrap_or("");
        if expected_size != Some(bytes.len() as u64)
            || mime.is_empty()
            || format!("{:x}", Sha256::digest(&bytes)) != digest
        {
            return Err(image_error(
                "image_payload_invalid",
                "payload_manifest_mismatch",
            ));
        }
        images.push(image_part(carrier, mime, &STANDARD.encode(&bytes)));
    }
    replace_first_user(body, carrier, user_content(carrier, text, images));
    Ok(())
}

/// One inline image in the carrier's wire shape.
fn image_part(carrier: Carrier, mime: &str, base64: &str) -> Value {
    let data_url = || format!("data:{mime};base64,{base64}");
    match carrier {
        Carrier::Responses => serde_json::json!({"type":"input_image","image_url":data_url()}),
        Carrier::Chat { .. } => {
            serde_json::json!({"type":"image_url","image_url":{"url":data_url()}})
        }
        Carrier::Anthropic => serde_json::json!({
            "type":"image","source":{"type":"base64","media_type":mime,"data":base64}
        }),
        Carrier::Gemini => serde_json::json!({"inline_data":{"mime_type":mime,"data":base64}}),
    }
}

/// The first user message's content: text before images for the OpenAI
/// shapes; images before text for Anthropic and Gemini, as their guides advise.
fn user_content(carrier: Carrier, text: &str, images: Vec<Value>) -> Value {
    let text_part = (!text.trim().is_empty()).then(|| match carrier {
        Carrier::Responses => serde_json::json!({"type":"input_text","text":text}),
        Carrier::Gemini => serde_json::json!({"text":text}),
        Carrier::Chat { .. } | Carrier::Anthropic => serde_json::json!({"type":"text","text":text}),
    });
    let content = match carrier {
        Carrier::Anthropic | Carrier::Gemini => images.into_iter().chain(text_part).collect(),
        Carrier::Responses | Carrier::Chat { .. } => text_part.into_iter().chain(images).collect(),
    };
    match carrier {
        Carrier::Responses => serde_json::json!([{"role":"user","content":content}]),
        _ => Value::Array(content),
    }
}

fn replace_first_user(body: &mut Value, carrier: Carrier, content: Value) {
    match carrier {
        Carrier::Responses => {
            if content.as_array().is_some_and(|value| {
                value
                    .first()
                    .and_then(|row| row.get("role"))
                    .and_then(Value::as_str)
                    == Some("user")
            }) {
                match body.get_mut("input").and_then(Value::as_array_mut) {
                    Some(input) => {
                        let rows = content.as_array().map(Vec::as_slice).unwrap_or_default();
                        let target = input
                            .iter()
                            .position(|row| row.get("role").and_then(Value::as_str) == Some("user"))
                            .map_or(0..0, |index| index..index + 1);
                        input.splice(target, rows.iter().cloned());
                    }
                    None => body["input"] = content,
                }
            }
        }
        Carrier::Chat { .. } | Carrier::Anthropic => {
            if let Some(message) = first_user_row(body, "messages") {
                message["content"] = content;
            }
        }
        Carrier::Gemini => {
            if let Some(message) = first_user_row(body, "contents") {
                message["parts"] = content;
            }
        }
    }
}

fn first_user_row<'a>(body: &'a mut Value, key: &str) -> Option<&'a mut Value> {
    body.get_mut(key)
        .and_then(Value::as_array_mut)?
        .iter_mut()
        .find(|row| row.get("role").and_then(Value::as_str) == Some("user"))
}

fn first_user_text<'a>(request: &'a ModelRoundRequest<'_>) -> &'a str {
    request
        .messages
        .iter()
        .find(|message| matches!(message.role, butler_turn::btcc::ModelRoundRole::User))
        .map(|message| message.content.as_ref())
        .unwrap_or("")
}

fn zai_prompt(prompt: &str, manifests: &[Value]) -> String {
    let files = manifests
        .iter()
        .map(|manifest| {
            format!(
                "- file_id={} ({}, {}x{})",
                text(manifest, "fileId"),
                text(manifest, "derivativeMimeType"),
                number(manifest, "width"),
                number(manifest, "height"),
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "{prompt}\n\nAttached images are available only through the admitted Z.AI Vision MCP tool.\nCall analyze_attached_image with one exact file_id below and a focused prompt before answering visual questions. Do not invent paths or send native image parts.\n{files}"
    )
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}
fn number(value: &Value, key: &str) -> f64 {
    value.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}
fn image_error(code: &str, reason: &str) -> ModelRoundError {
    ModelRoundError::ImageAdmission {
        code: code.into(),
        reason: reason.into(),
    }
}

#[cfg(test)]
mod tests;
