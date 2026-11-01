//! One billed image per request; no provider or model fallback.
mod gemini;
mod openai;
use crate::models::{ImageOutputEndpoint, ResolvedImageModel};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
pub struct NormalizedRect {
    pub x0: f32,
    pub y0: f32,
    pub x1: f32,
    pub y1: f32,
}
#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Background {
    Transparent,
    Opaque,
    Auto,
}
impl Background {
    fn as_str(self) -> &'static str {
        match self {
            Self::Transparent => "transparent",
            Self::Opaque => "opaque",
            Self::Auto => "auto",
        }
    }
}
pub struct InputImage {
    pub bytes: Vec<u8>,
    pub mime: String,
}
pub struct ImageGenRequest {
    pub target: ResolvedImageModel,
    pub prompt: String,
    pub size: Option<String>,
    pub quality: Option<String>,
    pub background: Option<Background>,
    pub inputs: Vec<InputImage>,
    pub mask: Option<Vec<u8>>,
    pub region_hint: Option<NormalizedRect>,
}
#[derive(Default)]
pub struct ImageUsage {
    pub input_text_tokens: Option<u64>,
    pub input_image_tokens: Option<u64>,
    pub output_image_tokens: Option<u64>,
    pub output_text_tokens: Option<u64>,
}
pub struct ImageGenResult {
    pub bytes: Vec<u8>,
    pub mime: &'static str,
    pub usage: ImageUsage,
    pub images: u32,
}
#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct ImageGenError {
    pub code: String,
    pub http_status: Option<u16>,
    pub message: String,
}
impl ImageGenError {
    pub fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.into(),
            http_status: None,
            message: message.into(),
        }
    }
}
pub async fn generate(
    request: ImageGenRequest,
    cancel: &CancellationToken,
) -> Result<ImageGenResult, ImageGenError> {
    tokio::select! {
        biased;
        ()=cancel.cancelled()=>Err(ImageGenError::new("cancelled", "Image request cancelled.")),
        result=tokio::time::timeout(std::time::Duration::from_secs(300), execute(request))=>
            result.map_err(|_| ImageGenError::new("image_timeout", "Image request timed out."))?,
    }
}
async fn execute(request: ImageGenRequest) -> Result<ImageGenResult, ImageGenError> {
    let client = tokio::task::spawn_blocking(crate::models::provider_http_client)
        .await
        .map_err(|_| ImageGenError::new("image_transport", "Image transport unavailable."))?
        .map_err(|_| ImageGenError::new("image_transport", "Image transport unavailable."))?;
    let provider = request.target.metadata.provider_id.clone();
    let endpoint = request.target.image_output.endpoint;
    let builder = match endpoint {
        ImageOutputEndpoint::OpenaiImages => openai::request(&client, &request).await?,
        ImageOutputEndpoint::GeminiInteractions => gemini::request(&client, &request).await?,
    }
    .purpose(butler_log::http::Purpose::provider(&provider, "image"))
    .phase(butler_log::http::Phase::current())
    .timeout(std::time::Duration::from_secs(300));
    let response = builder
        .send()
        .await
        .map_err(|_| ImageGenError::new("image_transport", "Image request failed."))?;
    let status = response.status().as_u16();
    let bytes = response.bytes().await.map_err(|_| {
        ImageGenError::new(
            "image_transport",
            "Image response interrupted in transit. You may retry the request.",
        )
    })?;
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| ImageGenError::new("image_response_invalid", "Invalid image response."))?;
    if !(200..300).contains(&status) {
        let message = value
            .pointer("/error/message")
            .and_then(Value::as_str)
            .or_else(|| value.get("message").and_then(Value::as_str))
            .unwrap_or("Image request failed.");
        let mut error = safe_error("image_provider_error", message, &request.target.api_key);
        error.http_status = Some(status);
        return Err(error);
    }
    let result = match endpoint {
        ImageOutputEndpoint::OpenaiImages => openai::response(&value),
        ImageOutputEndpoint::GeminiInteractions => gemini::response(&value),
    };
    result.map_err(|e| safe_error(&e.code, &e.message, &request.target.api_key))
}
fn safe_error(code: &str, message: &str, secret: &str) -> ImageGenError {
    let message = if secret.is_empty() {
        message.into()
    } else {
        message.replace(secret, "[redacted]")
    };
    ImageGenError::new(
        code,
        &crate::models::diagnostics::safe_text(&message).unwrap_or_default(),
    )
}
fn decode(data: &str, usage: ImageUsage) -> Result<ImageGenResult, ImageGenError> {
    let bytes = STANDARD
        .decode(data)
        .map_err(|_| ImageGenError::new("image_response_invalid", "Invalid image data."))?;
    let mime = match image::guess_format(&bytes) {
        Ok(image::ImageFormat::Png) => "image/png",
        Ok(image::ImageFormat::Jpeg) => "image/jpeg",
        Ok(image::ImageFormat::WebP) => "image/webp",
        _ => {
            return Err(ImageGenError::new(
                "image_response_invalid",
                "Unsupported image data.",
            ));
        }
    };
    Ok(ImageGenResult {
        bytes,
        mime,
        usage,
        images: 1,
    })
}
fn base(request: &ImageGenRequest, default: &str) -> String {
    let base = request
        .target
        .metadata
        .api_base_url
        .as_deref()
        .unwrap_or(default)
        .trim_end_matches('/');
    base.strip_suffix("/v1beta")
        .or_else(|| base.strip_suffix("/v1"))
        .unwrap_or(base)
        .into()
}

/// Resolve Gemini's source-shaped edit default before approval and dispatch.
pub async fn effective_size(request: &ImageGenRequest) -> Result<Option<String>, ImageGenError> {
    match request.target.image_output.endpoint {
        ImageOutputEndpoint::GeminiInteractions => gemini::size(request).await,
        ImageOutputEndpoint::OpenaiImages => Ok(request.size.clone()),
    }
}
