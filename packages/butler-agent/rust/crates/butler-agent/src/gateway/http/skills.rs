use std::sync::Arc;

use axum::{
    extract::{FromRequest, Multipart},
    http::StatusCode,
    response::Response,
};
use tokio::io::AsyncWriteExt;

use crate::gateway::protocol::{APP_PROTOCOL_VERSION, ApiEnvelope};
use crate::skills::StagedSkillArchive;

use super::{HttpError, HttpState, json};

pub(super) async fn get(state: Arc<HttpState>) -> Result<Response, HttpError> {
    let skills = state.application.list_skills().await?;
    json(
        StatusCode::OK,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data: skills,
        },
    )
}

pub(super) async fn import(
    state: Arc<HttpState>,
    request: axum::http::Request<axum::body::Body>,
) -> Result<Response, HttpError> {
    let mut multipart = Multipart::from_request(request, &()).await.map_err(|_| {
        HttpError::public(
            400,
            "invalid_multipart",
            "Skill import must be multipart form data.",
        )
    })?;
    let mut upload: Option<StagedSkillArchive> = None;
    let mut project_id = None;
    while let Some(mut field) = multipart.next_field().await.map_err(|_| invalid())? {
        match field.name() {
            Some("file") if upload.is_none() => {
                let name = field.file_name().unwrap_or("skill.zip").to_owned();
                let root = std::env::temp_dir()
                    .join(format!("butler-skill-upload-{}", uuid::Uuid::new_v4()));
                tokio::fs::create_dir_all(&root)
                    .await
                    .map_err(|_| invalid())?;
                let staged = StagedSkillArchive::new(name, root);
                let mut output = tokio::fs::File::create(staged.path())
                    .await
                    .map_err(|_| invalid())?;
                while let Some(chunk) = field.chunk().await.map_err(|_| invalid())? {
                    output.write_all(&chunk).await.map_err(|_| invalid())?;
                }
                output.flush().await.map_err(|_| invalid())?;
                upload = Some(staged);
            }
            Some("project_id") => {
                let value = field.text().await.map_err(|_| invalid())?;
                let value = value.trim();
                if !value.is_empty() {
                    project_id = Some(value.to_owned());
                }
            }
            _ => {}
        }
    }
    let upload = upload
        .ok_or_else(|| HttpError::public(400, "file_required", "A file field is required."))?;
    let result = state.application.import_skill(upload, project_id).await?;
    json(
        StatusCode::CREATED,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data: result,
        },
    )
}

fn invalid() -> HttpError {
    HttpError::public(
        400,
        "invalid_multipart",
        "Skill import must be multipart form data.",
    )
}
