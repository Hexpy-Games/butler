use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    time::Duration,
};

use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::{
    btcc::{AccessMode, GuidedInvocation, ModelRoundToolCall, ToolExecutionError},
    context::{ImageCapabilityEvidence, ImageCarrierTuple, VisualAttachmentManifest},
    json::JsonDocument,
    public_text::trim_js_whitespace,
};

use super::NativeGuidedTools;

const SERVER_ID: &str = "zai-vision";
const TOOL_NAME: &str = "analyze_image";
const MAX_PROMPT_UNITS: usize = 4_000;
const MCP_TIMEOUT: Duration = Duration::from_secs(60);

pub(super) fn supports(name: &str) -> bool {
    name == "analyze_attached_image"
}

pub(super) async fn execute(
    owner: &NativeGuidedTools,
    invocation: GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
) -> Result<JsonDocument, ToolExecutionError> {
    if owner.binding.access_mode != AccessMode::FullAccess {
        return Err(integrity(
            "image_analysis_requires_full_access",
            "Image analysis requires full access.",
        ));
    }
    let file_id = required_text(
        &call.arguments,
        "file_id",
        "image_file_id_required",
        "analyze_attached_image requires file_id",
    )?;
    let prompt = required_text(
        &call.arguments,
        "prompt",
        "image_prompt_required",
        "analyze_attached_image requires prompt",
    )?;
    if prompt.encode_utf16().count() > MAX_PROMPT_UNITS {
        return Err(integrity(
            "image_prompt_too_long",
            "analyze_attached_image prompt is too long",
        ));
    }

    let (tuple, capability, manifest, manifest_value) =
        admitted_image(&invocation.turn.context, &file_id)?;
    let digest = owner
        .mcp_client
        .zai_vision_tool_capability_digest(
            &tuple.provider_id,
            &tuple.model_id,
            capability.credential_id.as_deref(),
            invocation.cancellation,
        )
        .await
        .map_err(|_| integrity("zai_vision_carrier_changed", "Z.AI Vision carrier changed."))?;
    if digest != tuple.catalog_capability_digest
        || digest
            != capability
                .tool_capability_digest
                .as_deref()
                .unwrap_or_default()
    {
        return Err(integrity(
            "zai_vision_carrier_changed",
            "Z.AI Vision carrier changed.",
        ));
    }

    let bytes = owner
        .verified_image_payload
        .read(&manifest_value)
        .await
        .map_err(|_| {
            integrity(
                "image_payload_invalid",
                "Verified image payload is unavailable.",
            )
        })?;
    if bytes.len() != manifest.derivative_size_bytes
        || format!("{:x}", Sha256::digest(&bytes)) != manifest.derivative_digest
    {
        return Err(integrity(
            "image_payload_invalid",
            "Verified image payload is invalid.",
        ));
    }
    let extension = extension_for_mime(&manifest.derivative_mime_type)?;
    let temp =
        TempImageFile::create(&owner.binding.butler_data, extension, &bytes).map_err(|_| {
            integrity(
                "image_payload_invalid",
                "Verified image payload is invalid.",
            )
        })?;
    let image_path = temp.file_path().to_path_buf();
    let image_source = image_path
        .to_str()
        .map(str::to_owned)
        .ok_or_else(|| integrity("image_payload_invalid", "Verified image path is invalid."))?;
    let args = Map::from_iter([
        ("image_source".into(), Value::String(image_source)),
        ("prompt".into(), Value::String(prompt)),
    ]);
    let result = owner
        .mcp_client
        .call_tool_with_timeout(
            SERVER_ID,
            TOOL_NAME,
            args,
            MCP_TIMEOUT,
            invocation.cancellation,
        )
        .await
        .map_err(|_| integrity("mcp_server_unavailable", "Z.AI Vision is unavailable."))?;
    let value = project_result(result, &file_id, temp.directory(), image_path);
    JsonDocument::from_value(&value).map_err(|_| {
        integrity(
            "image_analysis_result_invalid",
            "Image analysis result could not be encoded.",
        )
    })
}

fn admitted_image(
    context: &Value,
    file_id: &str,
) -> Result<
    (
        ImageCarrierTuple,
        ImageCapabilityEvidence,
        VisualAttachmentManifest,
        Value,
    ),
    ToolExecutionError,
> {
    let attached = context
        .get("attachments")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|item| {
            item.get("kind").and_then(Value::as_str) == Some("image")
                && item.get("id").and_then(Value::as_str) == Some(file_id)
        });
    if !attached {
        return Err(integrity(
            "image_attachment_not_authorized",
            "Image attachment is not authorized for this turn.",
        ));
    }
    let admission = context.get("imageAdmission").ok_or_else(|| {
        integrity(
            "image_attachment_not_authorized",
            "Image attachment is not authorized for this turn.",
        )
    })?;
    let tuple: ImageCarrierTuple =
        serde_json::from_value(admission.get("tuple").cloned().ok_or_else(|| {
            integrity(
                "zai_vision_carrier_unverified",
                "Z.AI Vision carrier was not verified at admission.",
            )
        })?)
        .map_err(|_| {
            integrity(
                "zai_vision_carrier_unverified",
                "Z.AI Vision carrier was not verified at admission.",
            )
        })?;
    let capability: ImageCapabilityEvidence =
        serde_json::from_value(admission.get("capability").cloned().ok_or_else(|| {
            integrity(
                "zai_vision_carrier_unverified",
                "Z.AI Vision carrier was not verified at admission.",
            )
        })?)
        .map_err(|_| {
            integrity(
                "zai_vision_carrier_unverified",
                "Z.AI Vision carrier was not verified at admission.",
            )
        })?;
    if !frozen_carrier_valid(&tuple, &capability) {
        return Err(integrity(
            "zai_vision_carrier_unverified",
            "Z.AI Vision carrier was not verified at admission.",
        ));
    }
    let manifests = admission
        .get("manifests")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            integrity(
                "image_attachment_not_authorized",
                "Image attachment is not authorized for this turn.",
            )
        })?;
    let (manifest_value, manifest) = manifests
        .iter()
        .find(|value| value.get("fileId").and_then(Value::as_str) == Some(file_id))
        .map(|value| {
            serde_json::from_value::<VisualAttachmentManifest>(value.clone())
                .map(|manifest| (value.clone(), manifest))
                .map_err(|_| {
                    integrity(
                        "image_attachment_not_authorized",
                        "Image attachment is not authorized for this turn.",
                    )
                })
        })
        .transpose()?
        .ok_or_else(|| {
            integrity(
                "image_attachment_not_authorized",
                "Image attachment is not authorized for this turn.",
            )
        })?;
    Ok((tuple, capability, manifest, manifest_value))
}

fn frozen_carrier_valid(tuple: &ImageCarrierTuple, capability: &ImageCapabilityEvidence) -> bool {
    tuple.provider_id == "zai"
        && tuple.model_id == "glm-5.2"
        && tuple.carrier_protocol == "zai_mcp_vision"
        && tuple.endpoint_profile_id == capability.endpoint_profile_id
        && tuple.catalog_capability_revision == capability.catalog_capability_revision
        && tuple.catalog_capability_digest == capability.catalog_capability_digest
        && capability.provider_id == tuple.provider_id
        && capability.model_id == tuple.model_id
        && capability.carrier_protocol == tuple.carrier_protocol
        && capability.model_support == "supported"
        && capability.route_health == "healthy"
        && capability.tool_server_id.as_deref() == Some(SERVER_ID)
        && capability.tool_name.as_deref() == Some(TOOL_NAME)
        && capability.tool_capability_digest.as_deref()
            == Some(tuple.catalog_capability_digest.as_str())
}

fn required_text(
    args: &Map<String, Value>,
    key: &str,
    error_code: &'static str,
    missing_message: &'static str,
) -> Result<String, ToolExecutionError> {
    args.get(key)
        .and_then(Value::as_str)
        .map(trim_js_whitespace)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| integrity(error_code, missing_message))
}

fn extension_for_mime(mime: &str) -> Result<&'static str, ToolExecutionError> {
    match mime {
        "image/png" => Ok(".png"),
        "image/jpeg" => Ok(".jpeg"),
        "image/webp" => Ok(".webp"),
        _ => Err(integrity(
            "image_derivative_mime_unsupported",
            "Image derivative MIME type is unsupported.",
        )),
    }
}

fn project_result(result: Value, file_id: &str, temp_root: &Path, temp_path: PathBuf) -> Value {
    let ok = result.get("ok").and_then(Value::as_bool).unwrap_or(false);
    let tool_result = result.get("result").unwrap_or(&Value::Null);
    let mut projected = json!({
        "ok":ok,
        "file_id":file_id,
        "server_id":SERVER_ID,
        "tool_name":TOOL_NAME,
        "analysis":safe_analysis(tool_result, temp_root, &temp_path),
    });
    if let Some(error) = result.get("error") {
        projected["error"] = scrub_value(error.clone(), temp_root, &temp_path);
    }
    projected
}

fn safe_analysis(value: &Value, temp_root: &Path, temp_path: &Path) -> String {
    let text = value
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("text").and_then(Value::as_str))
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    let text = scrub_text(&text, temp_root, temp_path);
    let text = trim_js_whitespace(&text);
    if !text.is_empty() {
        return text.to_owned();
    }
    if let Some(structured) = value.get("structuredContent")
        && let Ok(text) = serde_json::to_string(structured)
    {
        let text = scrub_text(&text, temp_root, temp_path);
        let text = trim_js_whitespace(&text);
        if !text.is_empty() {
            return text.to_owned();
        }
    }
    "(Z.AI Vision returned no textual analysis.)".into()
}

fn scrub_value(mut value: Value, temp_root: &Path, temp_path: &Path) -> Value {
    if let Some(object) = value.as_object_mut()
        && let Some(message) = object
            .get("message")
            .and_then(Value::as_str)
            .map(str::to_owned)
    {
        object.insert(
            "message".into(),
            Value::String(scrub_text(&message, temp_root, temp_path)),
        );
    }
    value
}

fn scrub_text(value: &str, temp_root: &Path, temp_path: &Path) -> String {
    let root = temp_root.to_string_lossy();
    let path = temp_path.to_string_lossy();
    value
        .replace(path.as_ref(), "[redacted-image-source]")
        .replace(root.as_ref(), "[redacted-image-directory]")
}

fn integrity(code: &'static str, message: &'static str) -> ToolExecutionError {
    ToolExecutionError::Integrity(crate::btcc::BtccError::new(code, message))
}

struct TempImageFile {
    directory: PathBuf,
    path: PathBuf,
}

impl TempImageFile {
    fn create(root: &Path, extension: &str, bytes: &[u8]) -> io::Result<Self> {
        let directory = root.join(format!(".butler-zai-vision-{}", uuid::Uuid::new_v4()));
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&directory)?;
        let path = directory.join(format!("input{extension}"));
        let guard = Self { directory, path };
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&guard.path)?;
        file.write_all(bytes)?;
        file.flush()?;
        drop(file);
        Ok(guard)
    }

    fn file_path(&self) -> &Path {
        &self.path
    }

    fn directory(&self) -> &Path {
        &self.directory
    }
}

impl Drop for TempImageFile {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.directory);
    }
}

#[cfg(test)]
#[path = "image/tests.rs"]
mod tests;
