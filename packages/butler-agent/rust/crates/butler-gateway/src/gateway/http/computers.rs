//! Local-admin HTTP boundary for the SSH computer registry.
use super::*;
use crate::gateway::remote_computers::{
    self, AddInput, Computer, HostInput, ModelInput, ModelSource,
};

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
            let setup = state.application.setup()?;
            let main_model = setup.computer_model(None).await?.kind();
            (
                StatusCode::OK,
                serde_json::json!({"computers": computers, "main_model": main_model}),
            )
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
        (Method::POST, "/computers") => add(&state, request, root).await?,
        (Method::PUT, p) if p.starts_with("/computers/") => edit(&state, request, root, p).await?,
        (_, p) if p.starts_with("/computers/") && p.contains("/oauth/") => {
            oauth(&state, request, root, p).await?
        }
        (Method::POST, path) if path.starts_with("/computers/") && path.ends_with("/start") => {
            start(&state, request, root, path).await?
        }
        (Method::PATCH, p) if p.starts_with("/computers/") => {
            update_model(&state, request, root, p).await?
        }
        (method, p)
            if p.starts_with("/computers/")
                && (p.ends_with("/connection") || p.ends_with("/reconnect")) =>
        {
            connection(&state, root, &method, p).await?
        }
        (Method::DELETE, path) if path.starts_with("/computers/") => {
            let force = query(request.uri())
                .get("force")
                .is_some_and(|value| value == "true");
            (StatusCode::OK, delete(&state, root, path, force).await?)
        }
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

async fn publish_changed(state: &HttpState, id: &str, sign_in: bool) -> Result<(), HttpError> {
    let payload = serde_json::Map::from_iter([
        ("computer_id".into(), serde_json::json!(id)),
        ("sign_in".into(), serde_json::json!(sign_in)),
    ]);
    state
        .application
        .publish_gateway_event("computers.changed", payload)
        .await?;
    Ok(())
}

async fn add(
    state: &HttpState,
    request: Request<Body>,
    root: &std::path::Path,
) -> Result<(StatusCode, serde_json::Value), HttpError> {
    let bytes = read_body_with_limit(request.into_body(), 256 * 1024).await?;
    let input: AddInput = serde_json::from_slice(&bytes).map_err(|_| HttpError::invalid_json())?;
    let open = input.open_sign_in;
    let computer = remote_computers::add(root, input, state.shutdown.clone()).await?;
    publish_changed(
        state,
        computer.id(),
        open && *computer.model_source() == ModelSource::Chatgpt,
    )
    .await?;
    Ok((
        StatusCode::CREATED,
        serde_json::json!({"computer":computer.wire()?}),
    ))
}

#[derive(Default, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct StartInput {
    #[serde(default)]
    open_sign_in: bool,
}

async fn start(
    state: &HttpState,
    request: Request<Body>,
    root: &std::path::Path,
    path: &str,
) -> Result<(StatusCode, serde_json::Value), HttpError> {
    let bytes = read_body_with_limit(request.into_body(), 64 * 1024).await?;
    let input: StartInput = if bytes.is_empty() {
        StartInput::default()
    } else {
        serde_json::from_slice(&bytes).map_err(|_| HttpError::invalid_json())?
    };
    let data = remote_computers::change(
        &state.application.setup()?,
        root,
        path,
        true,
        false,
        &state.agent_version,
        state.shutdown.clone(),
    )
    .await?;
    let id = path
        .strip_prefix("/computers/")
        .and_then(|p| p.strip_suffix("/start"))
        .ok_or(HttpError::Internal)?;
    let computer = remote_computers::list(root)
        .await?
        .into_iter()
        .find(|c| c.id() == id);
    let sign_in = input.open_sign_in
        && computer.is_some_and(|computer| *computer.model_source() == ModelSource::Chatgpt);
    publish_changed(state, id, sign_in).await?;
    Ok((StatusCode::OK, data))
}

async fn edit(
    state: &HttpState,
    request: Request<Body>,
    root: &std::path::Path,
    path: &str,
) -> Result<(StatusCode, serde_json::Value), HttpError> {
    let id = path
        .strip_prefix("/computers/")
        .filter(|id| !id.is_empty() && !id.contains('/'))
        .ok_or_else(|| HttpError::public(404, "not_found", "Route not found."))?;
    let bytes = read_body_with_limit(request.into_body(), 256 * 1024).await?;
    let input: AddInput = serde_json::from_slice(&bytes).map_err(|_| HttpError::invalid_json())?;
    let open = input.open_sign_in;
    let (computer, target_changed) = remote_computers::edit(
        &state.application.setup()?,
        root,
        id,
        &state.agent_version,
        input,
        state.shutdown.clone(),
    )
    .await?;
    if target_changed && state.remote_live.connection(id).0 != remote_computers::Connection::Idle {
        state.remote_live.reconnect(
            super::remote_sessions::link(state)?,
            state.application.clone(),
            id,
        );
    }
    publish_changed(
        state,
        computer.id(),
        open && *computer.model_source() == ModelSource::Chatgpt,
    )
    .await?;
    Ok((
        StatusCode::OK,
        serde_json::json!({"computer": computer.wire()?}),
    ))
}

async fn delete(
    state: &HttpState,
    root: &std::path::Path,
    path: &str,
    force: bool,
) -> Result<serde_json::Value, HttpError> {
    let data = remote_computers::change(
        &state.application.setup()?,
        root,
        path,
        false,
        force,
        &state.agent_version,
        state.shutdown.clone(),
    )
    .await?;
    let id = path
        .strip_prefix("/computers/")
        .ok_or(HttpError::Internal)?;
    state.remote_live.stop(id);
    publish_changed(state, id, false).await?;
    Ok(data)
}

async fn connection(
    state: &HttpState,
    root: &std::path::Path,
    method: &Method,
    path: &str,
) -> Result<(StatusCode, serde_json::Value), HttpError> {
    let not_found = || HttpError::public(404, "not_found", "Route not found.");
    let (id, action) = path
        .strip_prefix("/computers/")
        .and_then(|p| p.rsplit_once('/'))
        .filter(|(id, _)| !id.is_empty() && !id.contains('/'))
        .ok_or_else(not_found)?;
    if !remote_computers::list(root)
        .await?
        .iter()
        .any(|c| c.id() == id)
    {
        return Err(HttpError::public(
            404,
            "computer_not_found",
            "Computer not found.",
        ));
    }
    let (state, error) = match (method, action) {
        (&Method::GET, "connection") => state.remote_live.connection(id),
        (&Method::POST, "reconnect") => state.remote_live.reconnect(
            super::remote_sessions::link(state)?,
            state.application.clone(),
            id,
        ),
        _ => return Err(not_found()),
    };
    Ok((
        StatusCode::OK,
        serde_json::json!({"state":state,"error":error}),
    ))
}

async fn update_model(
    state: &HttpState,
    request: Request<Body>,
    root: &std::path::Path,
    path: &str,
) -> Result<(StatusCode, serde_json::Value), HttpError> {
    let bytes = read_body_with_limit(request.into_body(), 64 * 1024)
        .await
        .map_err(|_| HttpError::invalid_json())?;
    let input: ModelInput =
        serde_json::from_slice(&bytes).map_err(|_| HttpError::invalid_json())?;
    let setup = state.application.setup()?;
    let open = input.open_sign_in;
    let computer = remote_computers::update_model(
        &setup,
        root,
        path,
        &state.agent_version,
        input,
        state.shutdown.clone(),
    )
    .await?;
    publish_changed(
        state,
        computer.id(),
        open && *computer.model_source() == ModelSource::Chatgpt,
    )
    .await?;
    Ok((
        StatusCode::OK,
        serde_json::json!({"computer": computer.wire()?}),
    ))
}

async fn oauth(
    state: &HttpState,
    request: Request<Body>,
    root: &std::path::Path,
    path: &str,
) -> Result<(StatusCode, serde_json::Value), HttpError> {
    let not_found = || HttpError::public(404, "not_found", "Route not found.");
    let (id, route) = path
        .strip_prefix("/computers/")
        .and_then(|p| p.split_once("/oauth/"))
        .filter(|(id, _)| !id.is_empty() && !id.contains('/'))
        .ok_or_else(not_found)?;
    let cancel = state.shutdown.clone();
    let data = match (request.method(), route) {
        (&Method::POST, "start") => {
            let bytes = read_body_with_limit(request.into_body(), 64 * 1024).await?;
            let input = if bytes.is_empty() {
                remote_computers::OauthStart::default()
            } else {
                serde_json::from_slice(&bytes).map_err(|_| HttpError::invalid_json())?
            };
            remote_computers::oauth_start(
                &state.application.setup()?,
                root,
                id,
                &state.agent_version,
                input,
                cancel,
            )
            .await?
        }
        (method, route) => {
            let (flow, suffix) = route
                .split_once('/')
                .map_or((route, None), |(flow, suffix)| (flow, Some(suffix)));
            if flow.is_empty() || !flow.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
                return Err(not_found());
            }
            match (method, suffix) {
                (&Method::GET, None) => {
                    remote_computers::oauth_flow(root, id, flow, cancel).await?
                }
                (&Method::POST, Some("cancel")) => {
                    remote_computers::oauth_cancel(root, id, flow, cancel).await?
                }
                _ => return Err(not_found()),
            }
        }
    };
    Ok((StatusCode::OK, data))
}
