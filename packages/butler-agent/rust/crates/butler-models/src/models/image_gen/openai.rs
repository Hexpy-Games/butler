use super::*;
use serde_json::json;
use std::io::Cursor;

pub(super) async fn request(
    client: &butler_log::http::Client,
    r: &ImageGenRequest,
) -> Result<butler_log::http::RequestBuilder, ImageGenError> {
    let base = base(r, "https://api.openai.com");
    let mut body =
        json!({"model":r.target.metadata.model_id,"prompt":r.prompt,"n":1,"output_format":"png"});
    if let Some(size) = &r.size {
        body["size"] = json!(size);
    }
    if let Some(quality) = &r.quality {
        body["quality"] = json!(quality);
    }
    if let Some(background) = r
        .background
        .filter(|b| *b != Background::Transparent || r.target.image_output.transparent_background)
    {
        body["background"] = json!(background.as_str());
    }
    if r.inputs.is_empty() {
        return Ok(client
            .post(format!("{base}/v1/images/generations"))
            .bearer_auth(r.target.api_key.as_str())
            .json(&body));
    }
    let inputs = r.inputs.iter().map(|i| i.bytes.clone()).collect::<Vec<_>>();
    let inputs = tokio::task::spawn_blocking(move || {
        inputs.into_iter().map(png).collect::<Result<Vec<_>, _>>()
    })
    .await
    .map_err(|_| ImageGenError::new("image_invalid", "Invalid input image."))??;
    let boundary = format!("butler-{}", uuid::Uuid::new_v4());
    let mut bytes = Vec::new();
    let fields = body
        .as_object()
        .ok_or_else(|| ImageGenError::new("image_invalid", "Invalid request."))?;
    for (key, value) in fields.iter().filter(|(key, _)| key.as_str() != "n") {
        part(
            &mut bytes,
            &boundary,
            key,
            None,
            value.as_str().unwrap_or("").as_bytes(),
        );
    }
    for input in inputs {
        part(&mut bytes, &boundary, "image[]", Some("image.png"), &input);
    }
    if let Some(mask) = &r.mask {
        part(&mut bytes, &boundary, "mask", Some("mask.png"), mask);
    }
    bytes.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    Ok(client
        .post(format!("{base}/v1/images/edits"))
        .bearer_auth(r.target.api_key.as_str())
        .header(
            "content-type",
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(bytes))
}
fn part(out: &mut Vec<u8>, boundary: &str, name: &str, file: Option<&str>, bytes: &[u8]) {
    out.extend_from_slice(
        format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"").as_bytes(),
    );
    if let Some(file) = file {
        out.extend_from_slice(
            format!("; filename=\"{file}\"\r\nContent-Type: image/png").as_bytes(),
        );
    }
    out.extend_from_slice(b"\r\n\r\n");
    out.extend_from_slice(bytes);
    out.extend_from_slice(b"\r\n");
}
fn png(bytes: Vec<u8>) -> Result<Vec<u8>, ImageGenError> {
    if image::guess_format(&bytes).ok() == Some(image::ImageFormat::Png) {
        return Ok(bytes);
    }
    let mut out = Cursor::new(Vec::new());
    image::load_from_memory(&bytes)
        .and_then(|i| i.write_to(&mut out, image::ImageFormat::Png))
        .map_err(|_| ImageGenError::new("image_invalid", "Invalid input image."))?;
    Ok(out.into_inner())
}
pub(super) fn response(value: &Value) -> Result<ImageGenResult, ImageGenError> {
    let u = &value["usage"];
    let usage = ImageUsage {
        input_text_tokens: u
            .pointer("/input_tokens_details/text_tokens")
            .and_then(Value::as_u64),
        input_image_tokens: u
            .pointer("/input_tokens_details/image_tokens")
            .and_then(Value::as_u64),
        output_image_tokens: u
            .pointer("/output_tokens_details/image_tokens")
            .and_then(Value::as_u64)
            .or_else(|| u["output_tokens"].as_u64()),
        output_text_tokens: u
            .pointer("/output_tokens_details/text_tokens")
            .and_then(Value::as_u64),
    };
    decode(
        value
            .pointer("/data/0/b64_json")
            .and_then(Value::as_str)
            .ok_or_else(|| ImageGenError::new("image_not_returned", "No image returned."))?,
        usage,
    )
}
