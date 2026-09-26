use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::btcc::{ModelRoundError, ModelRoundRequest};

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
        _ => "",
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
    let mut content = Vec::new();
    if !text.trim().is_empty() {
        content.push(match carrier {
            Carrier::Responses => serde_json::json!({"type":"input_text","text":text}),
            _ => serde_json::json!({"type":"text","text":text}),
        });
    }
    for manifest in manifests {
        let bytes = payload
            .read(manifest)
            .await
            .map_err(|error| image_error("image_payload_invalid", &error.code))?;
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
        let url = format!("data:{mime};base64,{}", STANDARD.encode(&bytes));
        content.push(match carrier {
            Carrier::Responses => serde_json::json!({"type":"input_image","image_url":url}),
            _ => serde_json::json!({"type":"image_url","image_url":{"url":url}}),
        });
    }
    replace_first_user(
        body,
        carrier,
        match carrier {
            Carrier::Responses => serde_json::json!([{"role":"user","content":content}]),
            _ => Value::Array(content),
        },
    );
    Ok(())
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
                if body.get("input").is_some_and(Value::is_array) {
                    let input = body.get_mut("input").and_then(Value::as_array_mut).unwrap();
                    if let Some(index) = input
                        .iter()
                        .position(|row| row.get("role").and_then(Value::as_str) == Some("user"))
                    {
                        input.splice(index..=index, content.as_array().unwrap().iter().cloned());
                    } else {
                        input.splice(0..0, content.as_array().unwrap().iter().cloned());
                    }
                } else {
                    body["input"] = content;
                }
            }
        }
        Carrier::Chat { .. } => {
            if let Some(message) = body
                .get_mut("messages")
                .and_then(Value::as_array_mut)
                .and_then(|messages| {
                    messages
                        .iter_mut()
                        .find(|row| row.get("role").and_then(Value::as_str) == Some("user"))
                })
            {
                message["content"] = content;
            }
        }
        _ => {}
    }
}

fn first_user_text<'a>(request: &'a ModelRoundRequest<'_>) -> &'a str {
    request
        .messages
        .iter()
        .find(|message| matches!(message.role, crate::btcc::ModelRoundRole::User))
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
