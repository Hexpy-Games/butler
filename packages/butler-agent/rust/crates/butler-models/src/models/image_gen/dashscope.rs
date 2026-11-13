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
            .unwrap_or("https://dashscope-intl.aliyuncs.com/compatible-mode/v1"),
    );
    let mut body = json!({"model":r.target.metadata.model_id,"prompt":r.prompt,"n":1,"size":r.size.as_deref().unwrap_or("auto")});
    if !r.inputs.is_empty() {
        body["image"] = json!(
            r.inputs
                .iter()
                .map(|i| format!("data:{};base64,{}", i.mime, STANDARD.encode(&i.bytes)))
                .collect::<Vec<_>>()
        );
    }
    Ok(client
        .post(format!("{base}/images/generations"))
        .bearer_auth(r.target.api_key.as_str())
        .json(&body))
}
