//! Local-admin HTTP boundary for the SSH computer registry.
use super::*;
use crate::gateway::remote_computers::{self, AddInput, Computer, HostInput, SendCredential};

pub(super) async fn route(
    state: Arc<HttpState>,
    request: Request<Body>,
) -> Result<Response, HttpError> {
    super::security_settings::local_client(request.extensions().get::<Client>())?;
    let root = state.output_data.as_deref().ok_or(HttpError::Internal)?;
    let path = request.uri().path().to_owned();
    let (status, data) = match (request.method().clone(), path.as_str()) {
        (Method::GET, "/computers") => {
            let computers = remote_computers::list(root)
                .await?
                .iter()
                .map(Computer::wire)
                .collect::<Result<Vec<_>, _>>()?;
            (StatusCode::OK, serde_json::json!({"computers": computers}))
        }
        (Method::POST, "/computers/host-key") => {
            let bytes = read_body_with_limit(request.into_body(), 256 * 1024).await?;
            let input: HostInput =
                serde_json::from_slice(&bytes).map_err(|_| HttpError::invalid_json())?;
            (
                StatusCode::OK,
                remote_computers::host_key(root, input, state.shutdown.clone()).await?,
            )
        }
        (Method::POST, "/computers") => {
            let bytes = read_body_with_limit(request.into_body(), 256 * 1024).await?;
            let input: AddInput =
                serde_json::from_slice(&bytes).map_err(|_| HttpError::invalid_json())?;
            let computer = remote_computers::add(root, input, state.shutdown.clone()).await?;
            (
                StatusCode::CREATED,
                serde_json::json!({"computer": computer.wire()?}),
            )
        }
        (Method::POST, path) if path.starts_with("/computers/") && path.ends_with("/start") => (
            StatusCode::OK,
            remote_computers::change(
                &state.application.setup()?,
                root,
                path,
                true,
                &state.agent_version,
                state.shutdown.clone(),
            )
            .await?,
        ),
        (Method::POST, p) if p.starts_with("/computers/") && p.ends_with("/credentials") => {
            send_credential(&state, request, root, p).await?
        }
        (Method::DELETE, path) if path.starts_with("/computers/") => (
            StatusCode::OK,
            remote_computers::change(
                &state.application.setup()?,
                root,
                path,
                false,
                &state.agent_version,
                state.shutdown.clone(),
            )
            .await?,
        ),
        _ => return Err(HttpError::public(404, "not_found", "Route not found.")),
    };
    json(
        status,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data,
        },
    )
}

async fn send_credential(
    state: &HttpState,
    request: Request<Body>,
    root: &std::path::Path,
    path: &str,
) -> Result<(StatusCode, serde_json::Value), HttpError> {
    let bytes = read_body_with_limit(request.into_body(), 64 * 1024)
        .await
        .map_err(|_| HttpError::invalid_json())?;
    let input: SendCredential =
        serde_json::from_slice(&bytes).map_err(|_| HttpError::invalid_json())?;
    let setup = state.application.setup()?;
    let key = setup.saved_provider_key(input.credential_id).await?;
    Ok((
        StatusCode::OK,
        remote_computers::send_credential(
            &setup,
            root,
            path,
            &state.agent_version,
            key,
            state.shutdown.clone(),
        )
        .await?,
    ))
}
