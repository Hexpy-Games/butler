//! Claimed App assets from the existing Conversation, image, and Models owners.

use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use serde_json::{Value, json};

use crate::gateway::AppImageFiles;
use crate::gateway::AppNativeAssetResolver;
use crate::gateway::ApplicationFuture;
use crate::gateway::ClaimedNativeSnapshot;
use crate::gateway::GatewayApplicationError;
use crate::gateway::ResolvedNativeAssets;
use crate::gateway::resolve_session_references;
use crate::models::ModelConfiguration;
use crate::models::VisualImageAdmissionResult;
use butler_turn::conversation::AgentConversationStore;

pub(crate) struct AppAssets {
    conversations: Arc<AgentConversationStore>,
    images: Arc<AppImageFiles>,
    models: Arc<ModelConfiguration>,
    mcp: Arc<crate::mcp_client::McpClient>,
    files_root: PathBuf,
}

impl AppAssets {
    pub(crate) fn new(
        conversations: Arc<AgentConversationStore>,
        images: Arc<AppImageFiles>,
        models: Arc<ModelConfiguration>,
        mcp: Arc<crate::mcp_client::McpClient>,
        data_root: &Path,
    ) -> Self {
        Self {
            conversations,
            images,
            models,
            mcp,
            files_root: data_root.join("app-server/message-files"),
        }
    }
}

impl AppNativeAssetResolver for AppAssets {
    fn resolve(&self, snapshot: ClaimedNativeSnapshot) -> ApplicationFuture<ResolvedNativeAssets> {
        let conversations = Arc::clone(&self.conversations);
        let images = Arc::clone(&self.images);
        let models = Arc::clone(&self.models);
        let mcp = Arc::clone(&self.mcp);
        let files_root = self.files_root.clone();
        Box::pin(async move {
            let visual = if needs_visual_validation(&snapshot) {
                let model_ref = snapshot
                    .execution_controls
                    .get("model_ref")
                    .and_then(Value::as_str)
                    .ok_or(GatewayApplicationError::internal())?;
                let catalog = Box::pin(crate::host::catalog_for_visual_admission(
                    &models, &mcp, model_ref,
                ))
                .await?;
                images
                    .validate_queued_visual(
                        &snapshot.queue_attachments,
                        &snapshot.attached_files,
                        model_ref,
                        &catalog,
                    )
                    .await?
            } else {
                None
            };
            let admission = visual
                .as_ref()
                .map(|value| {
                    serde_json::from_value::<VisualImageAdmissionResult>(value.clone())
                        .map_err(GatewayApplicationError::internal_from)
                })
                .transpose()?;
            let references = resolve_session_references(
                snapshot.content_parts.as_ref(),
                &snapshot.reference_chats,
                &conversations,
            )
            .await?;
            let attachments = snapshot
                .attached_files
                .iter()
                .map(|file| {
                    let manifest = admission.as_ref().and_then(|admission| {
                        admission
                            .manifests
                            .iter()
                            .find(|item| item.file_id == file.id)
                    });
                    if file.kind == "image" && manifest.is_none() {
                        return Err(GatewayApplicationError::Public {
                            status: 409,
                            code: "image_admission_missing".into(),
                            message: "Image attachment admission is missing.".into(),
                            source: None,
                        });
                    }
                    let kind = if file.kind == "image" {
                        "image"
                    } else if file.kind == "text" {
                        "document"
                    } else {
                        "binary"
                    };
                    let mut attachment = json!({
                        "id": file.id,
                        "kind": kind,
                        "mimeType": file.mime_type,
                        "fileName": file.safe_name,
                        "sizeBytes": file.size_bytes,
                        "url": format!("/message-files/{}", encode_uri_component(&file.id)),
                        "metadata": {"source":"message-file-store","createdAt":file.created_at},
                    });
                    if let Some(manifest) = manifest {
                        attachment["visualManifest"] = serde_json::to_value(manifest)
                            .map_err(GatewayApplicationError::internal_from)?;
                    } else {
                        attachment["localPath"] = files_root
                            .join(&file.storage_name)
                            .to_str()
                            .ok_or(GatewayApplicationError::internal())?
                            .into();
                    }
                    Ok(attachment)
                })
                .collect::<Result<Vec<_>, GatewayApplicationError>>()?;
            Ok(ResolvedNativeAssets {
                attachments: Value::Array(attachments),
                image_admission: visual,
                session_references: references,
            })
        })
    }
}

fn needs_visual_validation(snapshot: &ClaimedNativeSnapshot) -> bool {
    snapshot
        .attached_files
        .iter()
        .any(|file| file.kind == "image")
        || snapshot.queue_attachments.as_array().is_some_and(|items| {
            items.iter().any(|item| {
                item.as_object()
                    .is_some_and(|object| object.contains_key("file_id"))
            })
        })
}

fn encode_uri_component(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}
