use super::*;
use serde_json::json;
pub(super) async fn request(
    client: &butler_log::http::Client,
    r: &ImageGenRequest,
) -> Result<butler_log::http::RequestBuilder, ImageGenError> {
    let mut text = r.prompt.clone();
    if let Some(b) = r.region_hint {
        text.push_str(&format!("\nChange only the region from {:.0}% to {:.0}% across and {:.0}% to {:.0}% down (the rest of the image must stay identical).",b.x0*100.,b.x1*100.,b.y0*100.,b.y1*100.));
    }
    let mut input = vec![json!({"type":"text","text":text})];
    input.extend(
        r.inputs
            .iter()
            .map(|i| json!({"type":"image","mime_type":i.mime,"data":STANDARD.encode(&i.bytes)})),
    );
    let mut format = json!({"type":"image"});
    let size = size(r).await?;
    if let Some(size) = size {
        format["aspect_ratio"] = json!(size);
    }
    if let Some(quality) = &r.quality {
        format["image_size"] = json!(quality.to_uppercase());
    }
    Ok(client
        .post(format!(
            "{}/v1beta/interactions",
            base(r, "https://generativelanguage.googleapis.com")
        ))
        .header("x-goog-api-key", r.target.api_key.as_str())
        .json(&json!({"model":r.target.metadata.model_id,"input":input,"response_format":format})))
}
fn closest_ratio(bytes: &[u8], sizes: &[String]) -> Option<String> {
    let image = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .ok()?
        .into_dimensions()
        .ok()?;
    let ratio = f64::from(image.0) / f64::from(image.1);
    sizes
        .iter()
        .filter_map(|size| {
            let (w, h) = size.split_once(':')?;
            let distance = (w.parse::<f64>().ok()? / h.parse::<f64>().ok()? - ratio).abs();
            Some((size, distance))
        })
        .min_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(s, _)| s.clone())
}
pub(super) fn response(value: &Value) -> Result<ImageGenResult, ImageGenError> {
    let blocks = value["steps"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|s| s["type"] == "model_output")
        .flat_map(|s| s["content"].as_array().into_iter().flatten())
        .collect::<Vec<_>>();
    let image = blocks.iter().rev().find(|b| b["type"] == "image");
    let Some(data) = image.and_then(|b| b["data"].as_str()) else {
        let text = blocks
            .iter()
            .filter(|b| b["type"] == "text")
            .filter_map(|b| b["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n");
        return Err(ImageGenError::new(
            "image_not_returned",
            if text.is_empty() {
                "No image returned."
            } else {
                &text
            },
        ));
    };
    let usage = &value["usage"];
    let modality = |key: &str, name: &str| {
        usage[key]
            .as_array()
            .into_iter()
            .flatten()
            .find(|m| {
                m["modality"]
                    .as_str()
                    .is_some_and(|v| v.eq_ignore_ascii_case(name))
            })
            .and_then(|m| m["tokens"].as_u64())
    };
    decode(
        data,
        ImageUsage {
            input_text_tokens: modality("input_tokens_by_modality", "text"),
            input_image_tokens: modality("input_tokens_by_modality", "image"),
            output_image_tokens: modality("output_tokens_by_modality", "image")
                .or_else(|| usage["total_output_tokens"].as_u64()),
            output_text_tokens: modality("output_tokens_by_modality", "text"),
        },
    )
}

pub(super) async fn size(r: &ImageGenRequest) -> Result<Option<String>, ImageGenError> {
    let size = match (&r.size, r.inputs.first()) {
        (Some(size), _) => Some(size.clone()),
        (None, Some(input)) => {
            let bytes = input.bytes.clone();
            let sizes = r.target.image_output.sizes.clone();
            tokio::task::spawn_blocking(move || closest_ratio(&bytes, &sizes))
                .await
                .map_err(|_| ImageGenError::new("image_invalid", "Invalid input image."))?
        }
        _ => None,
    };
    Ok(size)
}
