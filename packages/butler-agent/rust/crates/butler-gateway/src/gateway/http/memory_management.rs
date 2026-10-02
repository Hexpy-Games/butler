use super::{HttpError, HttpState, json, read_body_with_limit};
use crate::gateway::{
    AppMemoryCommand,
    protocol::{APP_PROTOCOL_VERSION, ApiEnvelope},
};
use axum::{
    body::Body,
    http::{Method, StatusCode, Uri},
    response::Response,
};
use std::sync::Arc;

pub(super) async fn route(
    state: Arc<HttpState>,
    request: axum::http::Request<Body>,
    uri: &Uri,
) -> Result<Response, HttpError> {
    let (command, status) = match (request.method(), uri.path()) {
        (&Method::GET, "/memory/instructions") => (AppMemoryCommand::Instructions, StatusCode::OK),
        (&Method::DELETE, path) if path.starts_with("/memory/instructions/") => {
            (delete_instruction(request, path).await?, StatusCode::OK)
        }
        (&Method::GET, path) if path.starts_with("/memory/projects/") => {
            let id = path.strip_prefix("/memory/projects/").ok_or_else(invalid)?;
            if id.is_empty() || id.contains('/') {
                return Err(invalid());
            }
            (
                AppMemoryCommand::Project {
                    project_id: id.into(),
                },
                StatusCode::OK,
            )
        }
        (&Method::GET, "/memory/inventory") => (AppMemoryCommand::Inventory, StatusCode::OK),
        (&Method::POST, "/memory/inventory/check") => (AppMemoryCommand::Check, StatusCode::OK),
        (&Method::POST, path @ ("/memory/reset/profile" | "/memory/reset/chat-memory")) => {
            (reset_request(request, path).await?, StatusCode::ACCEPTED)
        }
        (&Method::POST, path) if path.starts_with("/memory/reset/projects/") => {
            (project_reset(request, path).await?, StatusCode::ACCEPTED)
        }
        (&Method::DELETE, path) if path.starts_with("/memory/reset/") => (
            AppMemoryCommand::Cancel {
                operation_id: reset_id(path)?,
            },
            StatusCode::OK,
        ),
        (&Method::GET, path) if path.starts_with("/memory/reset/") => {
            let id = reset_id(path)?;
            (
                AppMemoryCommand::ResetStatus { operation_id: id },
                StatusCode::OK,
            )
        }
        (&Method::POST, "/memory/cleanup") => {
            (cleanup_request(request).await?, StatusCode::ACCEPTED)
        }
        (&Method::GET, path) if path.starts_with("/memory/cleanup/") => (
            AppMemoryCommand::Status {
                operation_id: operation_id(path)?,
            },
            StatusCode::OK,
        ),
        (&Method::DELETE, path) if path.starts_with("/memory/cleanup/") => (
            AppMemoryCommand::Cancel {
                operation_id: operation_id(path)?,
            },
            StatusCode::OK,
        ),
        _ => return Err(HttpError::public(404, "not_found", "Route not found.")),
    };
    let data = state
        .application
        .memory_management(command, state.shutdown.child_token())
        .await?;
    json(
        status,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data,
        },
    )
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct DeleteInstruction {
    expected_revision: String,
    project_id: Option<String>,
    operation_id: String,
}

fn operation_id(path: &str) -> Result<String, HttpError> {
    let id = path.strip_prefix("/memory/cleanup/").ok_or_else(invalid)?;
    if uuid::Uuid::parse_str(id).is_ok_and(|u| u.to_string() == id) {
        Ok(id.into())
    } else {
        Err(invalid())
    }
}

fn invalid() -> HttpError {
    HttpError::public(400, "invalid_memory_request", "Invalid memory request.")
}

async fn delete_instruction(
    request: axum::http::Request<Body>,
    path: &str,
) -> Result<AppMemoryCommand, HttpError> {
    let handle = path
        .strip_prefix("/memory/instructions/")
        .ok_or_else(invalid)?;
    if handle.is_empty() || !handle.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(invalid());
    }
    let handle = handle.to_owned();
    let bytes = read_body_with_limit(request.into_body(), 4096).await?;
    let input: DeleteInstruction = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    if !uuid::Uuid::parse_str(&input.operation_id)
        .is_ok_and(|id| id.to_string() == input.operation_id)
        || input.expected_revision.is_empty()
    {
        return Err(invalid());
    }
    Ok(AppMemoryCommand::DeleteInstruction {
        handle,
        expected_revision: input.expected_revision,
        project_id: input.project_id,
        operation_id: input.operation_id,
    })
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ResetInput {
    operation_id: String,
    inventory_revision: u64,
}

async fn cleanup_request(
    request: axum::http::Request<Body>,
) -> Result<AppMemoryCommand, HttpError> {
    let bytes = read_body_with_limit(request.into_body(), 4096).await?;
    let input: ResetInput =
        serde_json::from_slice(&bytes).map_err(|_| HttpError::invalid_json())?;
    Ok(AppMemoryCommand::Cleanup {
        operation_id: input.operation_id,
        inventory_revision: input.inventory_revision,
    })
}

async fn reset_request(
    request: axum::http::Request<Body>,
    path: &str,
) -> Result<AppMemoryCommand, HttpError> {
    let bytes = read_body_with_limit(request.into_body(), 4096).await?;
    let input: ResetInput = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    if path == "/memory/reset/profile" {
        Ok(AppMemoryCommand::ResetProfile {
            operation_id: input.operation_id,
            inventory_revision: input.inventory_revision,
        })
    } else {
        Ok(AppMemoryCommand::ResetChat {
            operation_id: input.operation_id,
            inventory_revision: input.inventory_revision,
        })
    }
}

async fn project_reset(
    request: axum::http::Request<Body>,
    path: &str,
) -> Result<AppMemoryCommand, HttpError> {
    let project_id = path
        .strip_prefix("/memory/reset/projects/")
        .ok_or_else(invalid)?;
    if project_id.is_empty() || project_id.contains('/') {
        return Err(invalid());
    }
    let bytes = read_body_with_limit(request.into_body(), 4096).await?;
    let input: ResetInput = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    Ok(AppMemoryCommand::ResetProject {
        operation_id: input.operation_id,
        inventory_revision: input.inventory_revision,
        project_id: project_id.into(),
    })
}

fn reset_id(path: &str) -> Result<String, HttpError> {
    let id = path.strip_prefix("/memory/reset/").ok_or_else(invalid)?;
    if uuid::Uuid::parse_str(id).is_ok_and(|value| value.to_string() == id) {
        Ok(id.into())
    } else {
        Err(invalid())
    }
}
