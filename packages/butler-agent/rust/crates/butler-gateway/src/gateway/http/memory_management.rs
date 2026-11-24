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
mod patterns;

pub(super) async fn route(
    state: Arc<HttpState>,
    request: axum::http::Request<Body>,
    uri: &Uri,
) -> Result<Response, HttpError> {
    if uri.path().starts_with("/memory/instructions/pending") {
        return pending_route(state, request, uri).await;
    }
    if uri.path().starts_with("/memory/patterns")
        || uri.path().starts_with("/memory/pattern-proposals")
    {
        let command = patterns::command(request, uri.path()).await?;
        return execute(state, command, StatusCode::OK).await;
    }
    let (command, status) = match (request.method(), uri.path()) {
        (&Method::GET, "/memory/consolidation") => {
            (AppMemoryCommand::Consolidation, StatusCode::OK)
        }
        (&Method::POST, "/memory/consolidation") => {
            (consolidation_request(request).await?, StatusCode::ACCEPTED)
        }
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
        (&Method::POST, path) if is_reset_path(path) => {
            (reset_request(request, path).await?, StatusCode::ACCEPTED)
        }
        (&Method::POST, path) if path.starts_with("/memory/reset/") => {
            (scoped_reset(request, path).await?, StatusCode::ACCEPTED)
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
    execute(state, command, status).await
}

async fn pending_route(
    state: Arc<HttpState>,
    request: axum::http::Request<Body>,
    uri: &Uri,
) -> Result<Response, HttpError> {
    use crate::gateway::remote_computers::{decide_pending, get_pending};
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Decision {
        decision: String,
        expected_revision: Option<String>,
    }
    let root = state.output_data.as_deref().ok_or(HttpError::Internal)?;
    if request.method() == Method::GET && uri.path() == "/memory/instructions/pending" {
        let items = pending_with_chat_ids(&state, root).await?;
        return execute(
            state,
            AppMemoryCommand::PendingInstructions { items },
            StatusCode::OK,
        )
        .await;
    }
    let id = uri
        .path()
        .strip_prefix("/memory/instructions/pending/")
        .filter(|id| !id.is_empty() && !id.contains('/') && request.method() == Method::POST)
        .ok_or_else(|| HttpError::public(404, "not_found", "Route not found."))?;
    if get_pending(root, id).await.is_none() {
        return Err(HttpError::public(
            404,
            "pending_instruction_not_found",
            "Pending instruction not found.",
        ));
    }
    let bytes = read_body_with_limit(request.into_body(), 4096).await?;
    let input: Decision = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    decide_pending(root, id, |item| async {
        match input.decision.as_str() {
            "discard" => json(
                StatusCode::OK,
                ApiEnvelope {
                    protocol_version: APP_PROTOCOL_VERSION,
                    data: serde_json::json!({"ok":true}),
                },
            ),
            "apply" => {
                execute(
                    state.clone(),
                    AppMemoryCommand::ApplyPendingInstruction {
                        item,
                        expected_revision: input.expected_revision,
                    },
                    StatusCode::OK,
                )
                .await
            }
            _ => Err(invalid()),
        }
    })
    .await
}

async fn pending_with_chat_ids(
    state: &HttpState,
    root: &std::path::Path,
) -> Result<Vec<serde_json::Value>, HttpError> {
    let mut items = crate::gateway::remote_computers::list_pending(root).await;
    for item in &mut items {
        let Some(runtime_id) = item["session_id"].as_str() else {
            continue;
        };
        let Some(candidate) = runtime_id.strip_prefix("butler/app-") else {
            continue;
        };
        let Some(computer) = item["computer_id"].as_str() else {
            continue;
        };
        if crate::gateway::app_session_hint(candidate) == runtime_id
            && state
                .application
                .session_computer(candidate.to_owned())
                .await?
                .as_deref()
                == Some(computer)
        {
            item["chat_id"] = candidate.into();
        }
    }
    Ok(items)
}

fn is_reset_path(path: &str) -> bool {
    matches!(
        path,
        "/memory/reset/profile" | "/memory/reset/chat-memory" | "/memory/reset/reextract"
    )
}

async fn execute(
    state: Arc<HttpState>,
    command: AppMemoryCommand,
    status: StatusCode,
) -> Result<Response, HttpError> {
    let mut data = state
        .application
        .memory_management(command, state.shutdown.child_token())
        .await?;
    let status = if data
        .as_object_mut()
        .is_some_and(|v| v.remove("already_active").is_some())
    {
        StatusCode::OK
    } else {
        status
    };
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
    } else if path == "/memory/reset/reextract" {
        Ok(AppMemoryCommand::Reextract {
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

async fn scoped_reset(
    request: axum::http::Request<Body>,
    path: &str,
) -> Result<AppMemoryCommand, HttpError> {
    if path.starts_with("/memory/reset/projects/") {
        project_reset(request, path).await
    } else if path.starts_with("/memory/reset/computers/") {
        computer_reset(request, path).await
    } else {
        Err(HttpError::public(404, "not_found", "Route not found."))
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

async fn computer_reset(
    request: axum::http::Request<Body>,
    path: &str,
) -> Result<AppMemoryCommand, HttpError> {
    let computer_id = path
        .strip_prefix("/memory/reset/computers/")
        .ok_or_else(invalid)?;
    if computer_id.is_empty()
        || computer_id.len() > 64
        || !computer_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
    {
        return Err(invalid());
    }
    let bytes = read_body_with_limit(request.into_body(), 4096).await?;
    let input: ResetInput = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    Ok(AppMemoryCommand::ResetComputer {
        operation_id: input.operation_id,
        inventory_revision: input.inventory_revision,
        computer_id: computer_id.into(),
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

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ConsolidationInput {
    operation_id: String,
}

async fn consolidation_request(
    request: axum::http::Request<Body>,
) -> Result<AppMemoryCommand, HttpError> {
    let bytes = read_body_with_limit(request.into_body(), 4096).await?;
    let input: ConsolidationInput = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    if !uuid::Uuid::parse_str(&input.operation_id)
        .is_ok_and(|id| id.to_string() == input.operation_id)
    {
        return Err(invalid());
    }
    Ok(AppMemoryCommand::RunConsolidation {
        operation_id: input.operation_id,
    })
}
