use super::*;
use serde_json::json;

pub(super) fn request(
    client: &butler_log::http::Client,
    r: &ImageGenRequest,
) -> Result<butler_log::http::RequestBuilder, ImageGenError> {
    let base = versioned_base(
        r.target
            .metadata
            .api_base_url
            .as_deref()
            .unwrap_or("https://api.x.ai/v1"),
    );
    let mut body = json!({"model":r.target.metadata.model_id,"prompt":r.prompt,"n":1,"response_format":"b64_json"});
    if let Some(size) = &r.size {
        body["aspect_ratio"] = json!(size);
    }
    if let Some(quality) = &r.quality {
        body["resolution"] = json!(quality.to_lowercase());
    }
    let operation = if r.inputs.is_empty() {
        "generations"
    } else {
        body["images"] = json!(r.inputs.iter().map(|i| json!({"url":format!("data:{};base64,{}",i.mime,STANDARD.encode(&i.bytes)),"type":"image_url"})).collect::<Vec<_>>());
        "edits"
    };
    Ok(client
        .post(format!("{base}/images/{operation}"))
        .bearer_auth(r.target.api_key.as_str())
        .json(&body))
}
