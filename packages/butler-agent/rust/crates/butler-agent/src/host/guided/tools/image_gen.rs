//! Main-chat image calls: validate, authorize, dispatch once, composite, persist.
mod approval;
mod inputs;
use super::{GuidedTools, dispatch::encoded};
use base64::{Engine, engine::general_purpose::STANDARD};
use butler_core::json::JsonDocument;
use butler_models::models::{ImageGenError, ImageGenRequest, ImageGenResult};
use butler_turn::btcc::{AccessMode, GuidedInvocation, ModelRoundToolCall, ToolExecutionError};
use serde_json::{Value, json};
type Client = super::browser::client::Client;
pub(super) fn supports(name: &str) -> bool {
    matches!(name, "generate_image" | "edit_image")
}
pub(super) async fn execute(
    owner: &GuidedTools,
    invocation: GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    occurrence: &str,
) -> Result<JsonDocument, ToolExecutionError> {
    if owner.binding.access_mode == AccessMode::ReadOnly
        || owner.binding.allowed_tools_and_effects.is_some()
    {
        return failure("image_access_denied", "Image calls are unavailable.");
    }
    let Some(client) = Client::new(owner).await else {
        return failure("image_store_unavailable", "Image storage unavailable.");
    };
    let request = match inputs::prepare(owner, &client, call, invocation.cancellation).await {
        Ok(request) => request,
        Err(error) => return failure(&error.code, &error.message),
    };
    let facts = inputs::facts(call, &request);
    let reference = match approval::gate(owner, invocation, call, occurrence, &facts).await? {
        approval::Gate::Return(value) => return encoded(&value),
        approval::Gate::Allowed(reference) => reference,
    };
    let parent = if call.name == "edit_image" {
        Some(request.1[0].clone())
    } else {
        None
    };
    let model = request.0.target.metadata.clone();
    let quality = request.0.quality.clone();
    let size = request.0.size.clone();
    let source = request.0.inputs.first().map(|i| i.bytes.clone());
    let mask = request.0.mask.clone();
    owner
        .journal
        .dispatching(owner.binding.turn_id.clone(), occurrence.into())
        .await
        .map_err(|e| ToolExecutionError::Integrity(e.into()))?;
    let generated = butler_models::models::generate_image(request.0, invocation.cancellation).await;
    let result = match generated {
        Ok(result) => {
            persist(
                &client, invocation, call, result, source, mask, parent, &model, size, quality,
            )
            .await
        }
        Err(error) => Err(error),
    };
    approval::settle(
        owner,
        reference,
        if result.is_ok() { "applied" } else { "failed" },
    )
    .await?;
    match result {
        Ok(value) => encoded(&value),
        Err(error) => failure(&error.code, &error.message),
    }
}
#[expect(
    clippy::too_many_arguments,
    reason = "the immutable request facts and provider result describe one output"
)]
async fn persist(
    client: &Client,
    invocation: GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    result: ImageGenResult,
    source: Option<Vec<u8>>,
    mask: Option<Vec<u8>>,
    parent: Option<String>,
    model: &butler_models::models::ModelProviderMetadata,
    size: Option<String>,
    quality: Option<String>,
) -> Result<Value, ImageGenError> {
    let bytes = if let (Some(source), Some(mask)) = (source, mask) {
        tokio::task::spawn_blocking(move || {
            let source = image::load_from_memory(&source)
                .map_err(invalid)?
                .to_rgba8();
            let mask = image::load_from_memory(&mask).map_err(invalid)?.to_rgba8();
            let generated = image::load_from_memory(&result.bytes).map_err(invalid)?;
            let output =
                butler_gateway::gateway::composite(source, generated, mask).ok_or_else(|| {
                    ImageGenError::new(
                        "mask_size_mismatch",
                        "The mask does not match the image size.",
                    )
                })?;
            let mut bytes = std::io::Cursor::new(Vec::new());
            image::DynamicImage::ImageRgba8(output)
                .write_to(&mut bytes, image::ImageFormat::Png)
                .map_err(invalid)?;
            Ok::<_, ImageGenError>(bytes.into_inner())
        })
        .await
        .map_err(invalid)??
    } else {
        result.bytes
    };
    if invocation.cancellation.is_cancelled() {
        return Err(ImageGenError::new("cancelled", "Image request cancelled."));
    }
    let stored = client
        .call(
            "images.store",
            &Value::Null,
            &json!({"data":STANDARD.encode(bytes),"parent_id":parent,"model_ref":model.model_ref}),
            invocation.cancellation,
        )
        .await;
    let id = stored["id"]
        .as_str()
        .ok_or_else(|| ImageGenError::new("image_store_failed", "Image could not be stored."))?;
    let usage = result.usage;
    let recorded=client.call("images.usage",&Value::Null,&json!({"ts":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"model_ref":model.model_ref,"provider_id":model.provider_id,"op":if call.name=="edit_image"{"edit"}else{"generate"},"images":result.images,"input_text_tokens":usage.input_text_tokens,"input_image_tokens":usage.input_image_tokens,"output_image_tokens":usage.output_image_tokens,"quality":quality}),invocation.cancellation).await;
    if recorded["ok"] != true {
        return Err(ImageGenError::new(
            "image_usage_failed",
            "Image usage could not be recorded.",
        ));
    }
    Ok(
        json!({"schema":"butler.image.v1","status":"ok","image":id,"parent":parent,"width":stored["width"],"height":stored["height"],"model":model.display_name,"model_ref":model.model_ref,"size":size,"quality":quality,"url":stored["signed_url"]}),
    )
}
fn invalid(_: impl std::fmt::Display) -> ImageGenError {
    ImageGenError::new("image_invalid", "Invalid image data.")
}
fn failure(code: &str, message: &str) -> Result<JsonDocument, ToolExecutionError> {
    let mut error = json!({"code":code,"message":message});
    if matches!(code, "image_transport" | "image_timeout") {
        error["retryable"] = json!(true);
    }
    encoded(&json!({"status":"error","ok":false,"error":error}))
}
