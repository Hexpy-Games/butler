//! Images produced by the admitted output_check tool, projected as visual input.
use base64::{Engine, engine::general_purpose::STANDARD};
use butler_turn::btcc::ModelRoundMessage;
use serde_json::{Value, json};

pub(super) fn parts(message: &ModelRoundMessage) -> Option<(String, String)> {
    if !matches!(
        message.name.as_deref(),
        Some(
            "output_check" | "browser_observe" | "browser_act" | "browser_screenshot" | "tool_call"
        )
    ) {
        return None;
    }
    let mut value: Value = serde_json::from_str(&message.content).ok()?;
    let output = value.get_mut("output")?;
    if !matches!(
        output["schema"].as_str(),
        Some(
            "butler.output-check.v1"
                | "butler.browser-observation.v1"
                | "butler.browser-capture.v1"
        )
    ) {
        return None;
    }
    let image = output.as_object_mut()?.remove("image")?;
    if image["mime_type"] != "image/jpeg" {
        return None;
    }
    let data = image["data"].as_str()?;
    let bytes = STANDARD.decode(data).ok()?;
    if bytes.len() > 150 * 1024 || !bytes.starts_with(&[0xff, 0xd8]) {
        return None;
    }
    Some((value.to_string(), format!("data:image/jpeg;base64,{data}")))
}
pub(super) fn response_output(message: &ModelRoundMessage) -> Value {
    match parts(message) {
        Some((text, url)) => {
            json!([{"type":"input_text","text":text},{"type":"input_image","image_url":url}])
        }
        None => json!(message.content),
    }
}

pub(super) fn validate(
    request: &butler_turn::btcc::ModelRoundRequest<'_>,
    metadata: &crate::models::ModelProviderMetadata,
) -> Result<(), butler_turn::btcc::ModelRoundError> {
    if request.messages.iter().any(|m| parts(m).is_some())
        && metadata.image_input_support.as_deref() != Some("supported")
    {
        return Err(butler_turn::btcc::ModelRoundError::ImageAdmission {
            code: "image_model_unsupported".into(),
            reason: "Browser images require a vision-capable model.".into(),
        });
    }
    Ok(())
}
pub(super) fn anthropic_output(message: &ModelRoundMessage) -> Value {
    let content = match parts(message) {
        Some((text, url)) => {
            json!([{"type":"text","text":text},{"type":"image","source":{"type":"base64","media_type":"image/jpeg","data":url.trim_start_matches("data:image/jpeg;base64,")}}])
        }
        None => json!(message.content),
    };
    json!({"role":"user","content":[{"type":"tool_result","tool_use_id":message.tool_call_id,"content":content}]})
}
pub(super) fn gemini_output(message: &ModelRoundMessage) -> Value {
    let (text, image) = match parts(message) {
        Some((text, url)) => (
            text,
            Some(
                json!({"inlineData":{"mimeType":"image/jpeg","data":url.trim_start_matches("data:image/jpeg;base64,")}}),
            ),
        ),
        None => (message.content.to_string(), None),
    };
    let response: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!({"output":text}));
    let mut parts = vec![
        json!({"functionResponse":{"name":message.name.as_deref().unwrap_or("unknown_tool"),"response":response}}),
    ];
    parts.extend(image);
    json!({"role":"user","parts":parts})
}
