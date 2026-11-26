//! Owner-only socket routes of a remote Butler: account unlock and session creation.
use super::*;
use crate::gateway::{
    AppChatKind, AppCreateProjectRequest, AppCreateSessionInput, AppCreateSessionRequest,
    AppProjectSource, AppWorkspaceMode,
};
use axum::response::IntoResponse;
use butler_models::models::{
    ComputerEnvironmentReplaceError, load_computer_environment, replace_computer_environment,
    sealed::{self, SealedError},
};
use std::collections::BTreeMap;
use std::path::Path;

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Unlock {
    identity: String,
}

/// The remote routes exist only for the main: POST over the owner-only
/// socket, with the admin credential, in remote mode. Otherwise 404. Checked
/// after admission so the access log names the route.
pub(super) fn admitted(state: &HttpState, request: &Request<Body>) -> bool {
    request.method() == Method::POST && from_main(state, request)
}

/// A request from the main: over the owner-only socket, with the admin credential, in remote mode.
pub(super) fn from_main(state: &HttpState, request: &Request<Body>) -> bool {
    sealed::is_enabled()
        && request
            .extensions()
            .get::<listeners::LocalSocketPeer>()
            .is_some()
        && state.security.is_admin(request.headers())
}

pub(super) async fn unlock(request: Request<Body>) -> Result<Response, HttpError> {
    let bytes = read_body_with_limit(request.into_body(), MAX_REQUEST_BODY_SIZE).await?;
    let input: Unlock = serde_json::from_slice(&bytes).map_err(|_| HttpError::invalid_json())?;
    tokio::task::spawn_blocking(move || {
        sealed::unlock(&input.identity)?;
        if load_computer_environment().is_err() {
            butler_core::diagnostic!("[remote-env] could not load the sealed environment");
        }
        Ok(())
    })
    .await
    .map_err(|_| HttpError::Internal)?
    .map_err(|error| match error {
        SealedError::InvalidIdentity => HttpError::invalid_json(),
        SealedError::KeyMismatch => HttpError::public(403, error.code(), &error.to_string()),
        _ => HttpError::Internal,
    })?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Environment {
    variables: BTreeMap<String, String>,
}

pub(super) async fn environment(request: Request<Body>) -> Result<Response, HttpError> {
    let bytes = read_body_with_limit(request.into_body(), 1024 * 1024).await?;
    let input: Environment =
        serde_json::from_slice(&bytes).map_err(|_| HttpError::invalid_json())?;
    tokio::task::spawn_blocking(move || replace_computer_environment(input.variables))
        .await
        .map_err(|_| HttpError::Internal)?
        .map_err(|error| match error {
            ComputerEnvironmentReplaceError::Invalid(error) => {
                crate::gateway::remote_computers::environment::invalid(&error)
            }
            ComputerEnvironmentReplaceError::Sealed(error @ SealedError::KeyPending) => {
                HttpError::public(409, error.code(), &error.to_string())
            }
            ComputerEnvironmentReplaceError::Sealed(_) => HttpError::Internal,
        })?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct NewSession {
    session_id: String,
    folder: String,
    title: Option<String>,
}

/// `POST /remote/sessions`: the main's conversation as a project session in the computer's folder.
pub(super) async fn create_session(
    state: Arc<HttpState>,
    request: Request<Body>,
) -> Result<Response, HttpError> {
    let bytes = read_body_with_limit(request.into_body(), MAX_REQUEST_BODY_SIZE).await?;
    let input: NewSession =
        serde_json::from_slice(&bytes).map_err(|_| HttpError::invalid_json())?;
    if input.session_id.is_empty()
        || !input
            .session_id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err(HttpError::public(
            400,
            "invalid_request",
            "A valid session id is required.",
        ));
    }
    let home = butler_platform::user_dirs::non_empty_home_dir();
    let invalid_folder = || {
        HttpError::public(
            400,
            "project_folder_invalid",
            "Project folder is not available.",
        )
    };
    let mut folder = butler_platform::tool_paths::expand_home(&input.folder, home.as_deref())
        .map_err(|_| invalid_folder())?;
    if Path::new(&folder).is_relative() {
        folder = home
            .ok_or_else(invalid_folder)?
            .join(&folder)
            .to_string_lossy()
            .into_owned();
    }
    let project = state
        .application
        .create_project(AppCreateProjectRequest {
            source: AppProjectSource::AdminPath,
            display_name: None,
            folder_selection_token: None,
            workspace_path: Some(folder),
        })
        .await?
        .project;
    let created = state
        .application
        .create_session(
            AppCreateSessionRequest {
                input: AppCreateSessionInput {
                    kind: AppChatKind::Project,
                    title: input.title,
                    project_id: Some(project.id),
                    session_hint: Some(input.session_id),
                    group_id: None,
                },
                workspace_mode: AppWorkspaceMode::Local,
                computer_id: None,
            },
            state.shutdown.clone(),
        )
        .await?;
    json(
        StatusCode::CREATED,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data: created,
        },
    )
}

pub(super) async fn session_state(state: &HttpState) -> Result<Response, HttpError> {
    let sessions: Vec<_> = state.application.list_sessions(None, None, None).await?
        .into_iter()
        .filter(|session| {
            session.attention_required || matches!(
                session.active_turn_state.as_deref(),
                Some(state) if !matches!(state, "delivered" | "cancelled" | "failed" | "runtime_fault")
            )
        })
        .map(|session| crate::gateway::remote_computers::SessionStateRow {
            session_id: session.id,
            active_turn_state: session.active_turn_state,
            attention_required: session.attention_required,
        })
        .collect();
    json(
        StatusCode::OK,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data: serde_json::json!({"sessions": sessions}),
        },
    )
}
