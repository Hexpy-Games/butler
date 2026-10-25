use super::*;
use butler_models::models::{Background, InputImage, NormalizedRect};
use tokio_util::sync::CancellationToken;
pub(super) async fn prepare(
    owner: &GuidedTools,
    client: &Client,
    call: &ModelRoundToolCall,
    cancel: &CancellationToken,
) -> Result<(ImageGenRequest, Vec<String>), ImageGenError> {
    let target = owner
        .monitoring
        .configuration
        .resolve_image_model()
        .await
        .ok()
        .flatten()
        .ok_or_else(|| {
            ImageGenError::new(
                "image_model_not_ready",
                "Choose an image model with an API key in Settings.",
            )
        })?;
    let args = Value::Object(call.arguments.clone());
    let prompt = args["prompt"]
        .as_str()
        .filter(|p| !p.trim().is_empty())
        .ok_or_else(|| ImageGenError::new("image_prompt_required", "A prompt is required."))?
        .to_owned();
    let size = option(&args, "size")?;
    let quality = option(&args, "quality")?.unwrap_or_else(|| target.default_quality.clone());
    validate_choice("size", size.as_deref(), &target.image_output.sizes)?;
    validate_choice("quality", Some(&quality), &target.image_output.qualities)?;
    if call.name == "edit_image" && !target.image_output.edit {
        return Err(ImageGenError::new(
            "image_edit_unsupported",
            "This model cannot edit images.",
        ));
    }
    let background = background(&args, target.image_output.transparent_background)?;
    let ids = input_ids(call, &args)?;
    if ids.len() > target.image_output.max_input_images as usize {
        return Err(ImageGenError::new(
            "image_input_limit",
            &format!(
                "At most {} input images.",
                target.image_output.max_input_images
            ),
        ));
    }
    let (inputs, resolved) = load_inputs(client, ids, cancel).await?;
    let (mask, region_hint) = load_mask(client, &args, &resolved, &inputs, cancel).await?;
    let mut request = ImageGenRequest {
        target,
        prompt,
        size,
        quality: Some(quality),
        background,
        inputs,
        mask,
        region_hint,
    };
    request.size = butler_models::models::image_effective_size(&request).await?;
    Ok((request, resolved))
}

fn option(args: &Value, key: &str) -> Result<Option<String>, ImageGenError> {
    args.get(key)
        .map(|v| {
            v.as_str().map(str::to_owned).ok_or_else(|| {
                ImageGenError::new(
                    "image_parameter_invalid",
                    &format!("{key} must be a string."),
                )
            })
        })
        .transpose()
}
fn validate_choice(
    key: &str,
    value: Option<&str>,
    choices: &[String],
) -> Result<(), ImageGenError> {
    if value.is_some_and(|v| !choices.iter().any(|c| c == v)) {
        return Err(ImageGenError::new(
            "image_parameter_invalid",
            &format!("Valid {key} values: {}.", choices.join(", ")),
        ));
    }
    Ok(())
}
async fn load(
    client: &Client,
    id: &str,
    mask_for: Option<&str>,
    cancel: &CancellationToken,
) -> Result<(Value, Vec<u8>), ImageGenError> {
    let value = client
        .call(
            "images.resolve",
            &Value::Null,
            &json!({"id":id,"mask_for":mask_for}),
            cancel,
        )
        .await;
    let bytes = value["data"]
        .as_str()
        .and_then(|s| STANDARD.decode(s).ok())
        .ok_or_else(|| ImageGenError::new("image_not_in_chat", "Image is not in this chat."))?;
    Ok((value, bytes))
}
pub(super) fn facts(call: &ModelRoundToolCall, request: &(ImageGenRequest, Vec<String>)) -> Value {
    let r = &request.0;
    json!({"action":if call.name=="edit_image"{"edit"}else{"generate"},"model":r.target.metadata.display_name,"model_ref":r.target.metadata.model_ref,
        "size":r.size.as_deref().unwrap_or(if r.target.image_output.endpoint == butler_models::models::ImageOutputEndpoint::GeminiInteractions {"1:1"} else {"auto"}),"quality":r.quality,"images":if call.name=="edit_image" { json!([call.arguments.get("image")]) } else { call.arguments.get("images").cloned().unwrap_or_else(||json!([])) },"mask":call.arguments.get("mask"),"prompt":r.prompt})
}

fn background(args: &Value, transparent: bool) -> Result<Option<Background>, ImageGenError> {
    option(args, "background")?
        .map(|s| match s.as_str() {
            "opaque" => Ok(Background::Opaque),
            "transparent" if transparent => Ok(Background::Transparent),
            _ => Err(ImageGenError::new(
                "image_background_invalid",
                if transparent {
                    "Valid backgrounds: opaque, transparent."
                } else {
                    "Valid backgrounds: opaque."
                },
            )),
        })
        .transpose()
}
fn input_ids(call: &ModelRoundToolCall, args: &Value) -> Result<Vec<String>, ImageGenError> {
    Ok(if call.name == "edit_image" {
        vec![
            args["image"]
                .as_str()
                .ok_or_else(|| ImageGenError::new("image_required", "An image is required."))?
                .to_owned(),
        ]
    } else {
        match args.get("images") {
            None => Vec::new(),
            Some(Value::Array(items)) => items
                .iter()
                .map(|v| {
                    v.as_str().map(str::to_owned).ok_or_else(|| {
                        ImageGenError::new("image_input_invalid", "Invalid image ids.")
                    })
                })
                .collect::<Result<Vec<_>, _>>()?,
            _ => {
                return Err(ImageGenError::new(
                    "image_input_invalid",
                    "Invalid image ids.",
                ));
            }
        }
    })
}
async fn load_inputs(
    client: &Client,
    ids: Vec<String>,
    cancel: &CancellationToken,
) -> Result<(Vec<InputImage>, Vec<String>), ImageGenError> {
    let mut inputs = Vec::new();
    let mut resolved = Vec::new();
    for id in ids {
        let (value, bytes) = load(client, &id, None, cancel).await?;
        resolved.push(
            value["id"]
                .as_str()
                .ok_or_else(|| invalid("missing id"))?
                .to_owned(),
        );
        let mime = match image::guess_format(&bytes).map_err(invalid)? {
            image::ImageFormat::Png => "image/png",
            image::ImageFormat::Jpeg => "image/jpeg",
            image::ImageFormat::WebP => "image/webp",
            _ => return Err(invalid("unsupported")),
        };
        inputs.push(InputImage {
            bytes,
            mime: mime.into(),
        });
    }
    Ok((inputs, resolved))
}
async fn load_mask(
    client: &Client,
    args: &Value,
    resolved: &[String],
    inputs: &[InputImage],
    cancel: &CancellationToken,
) -> Result<(Option<Vec<u8>>, Option<NormalizedRect>), ImageGenError> {
    Ok(match option(args, "mask")? {
        Some(id) => {
            let parent = resolved.first().ok_or_else(|| invalid("missing parent"))?;
            let (_, bytes) = load(client, &id, Some(parent), cancel).await?;
            let copy = bytes.clone();
            let source = inputs[0].bytes.clone();
            let bounds = tokio::task::spawn_blocking(move || {
                let mask = image::load_from_memory(&copy).map_err(invalid)?.to_rgba8();
                let source = image::load_from_memory(&source).map_err(invalid)?;
                if mask.dimensions() != (source.width(), source.height()) {
                    return Err(invalid("dimensions"));
                }
                butler_gateway::gateway::mask_bounds(&mask)
                    .ok_or_else(|| ImageGenError::new("mask_empty", "The mask has no edit region."))
            })
            .await
            .map_err(invalid)??;
            (Some(bytes), Some(bounds))
        }
        None => (None, None),
    })
}
