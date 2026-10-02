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
use serde_json::Value;
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
        (&Method::POST, "/memory/cleanup") => {
            let bytes = read_body_with_limit(request.into_body(), 4096).await?;
            let input: Value =
                serde_json::from_slice(&bytes).map_err(|_| HttpError::invalid_json())?;
            let object = input.as_object().ok_or_else(invalid)?;
            if object.len() != 2 {
                return Err(invalid());
            }
            let id = object
                .get("operation_id")
                .and_then(Value::as_str)
                .ok_or_else(invalid)?
                .to_owned();
            let revision = object
                .get("inventory_revision")
                .and_then(Value::as_u64)
                .ok_or_else(invalid)?;
            (
                AppMemoryCommand::Cleanup {
                    operation_id: id,
                    inventory_revision: revision,
                },
                StatusCode::ACCEPTED,
            )
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
