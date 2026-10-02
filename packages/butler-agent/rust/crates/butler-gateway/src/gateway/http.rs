mod authority;
mod start;
pub(super) use start::serve;
mod automations;
mod dashboard;
mod error;
mod feedback;
mod listeners;
mod mcp_servers;
mod memory_management;
mod message_files;
mod model_catalog;
mod monitors;
mod new_chat_briefing;
mod operation_output;
mod owner_memory;
mod params;
mod personalization;
mod project_session_mutations;
mod projects;
mod read_routes;
mod retry;
mod security;
mod security_settings;
mod session_branches;
mod session_controls;
mod session_queue;
mod sessions;
mod settings;
mod setup;
mod shell;
mod skills;
mod space_mutations;
mod static_ui;
mod subsession_result;
mod subsessions;
mod transcript_export;
mod updates;
mod wallpaper_modules;
mod wallpapers;

use axum::http::HeaderValue;
use std::{error::Error as StdError, net::SocketAddr, path::PathBuf, sync::Arc};

use axum::{
    body::{Body, Bytes, to_bytes},
    extract::{ConnectInfo, State},
    http::{Method, Request, StatusCode, Uri, header},
    response::Response,
};
use http_body_util::LengthLimitError;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::{
    EventReplayView, GatewayApplication, GatewaySecurityStore, HealthView, SendMessageCommand,
    live::create_live_stream,
    message_validation::{MessageRequestError, validate_message_request},
    protocol::{APP_PROTOCOL_VERSION, ApiEnvelope},
    rate_limit::FixedWindowRateLimiter,
};
pub(super) use error::HttpError;
use error::{error_response, json};
use params::{cursor_param, limit_param, query};
use read_routes::{
    get_artifacts, get_events, get_live_events, get_messages, get_session_queue, get_turns, health,
};

const DEFAULT_PAGE_LIMIT: usize = 200;
const MAX_REQUEST_BODY_SIZE: usize = 128 * 1024 * 1024;

struct HttpState {
    devices: security::DeviceRegistry,
    application: Arc<dyn GatewayApplication>,
    security: security::GatewaySecurity,
    remote: listeners::RemoteAccess,
    security_store: Option<Arc<dyn GatewaySecurityStore>>,
    session_cursor_secret: String,
    limiter: FixedWindowRateLimiter,
    shutdown: CancellationToken,
    uploads: tokio::sync::Semaphore,
    static_ui_root: Option<PathBuf>,
}

/// Who sent an authorized request (a request extension for the routes).
#[derive(Clone)]
struct Client {
    access: security::Access,
    /// From this computer (see [`security::is_local_client`]).
    local: bool,
    /// Sent the local admin credential (`X-Butler-Admin`).
    admin: bool,
    /// The key set the request was authorized under.
    keys: security::KeySet,
}

/// Host and Origin admission, CORS preflight before auth, then the
/// authorized route; every answer to an admitted origin carries CORS headers.
async fn dispatch(State(state): State<Arc<HttpState>>, request: Request<Body>) -> Response {
    let connect_form =
        request.method() == Method::POST && request.uri().path() == security::CONNECT_PATH;
    let html_connect_form = connect_form && static_ui::accepts_html(request.headers());
    let origin =
        match state
            .security
            .admit(request.method(), request.uri().path(), request.headers())
        {
            Ok(origin) => origin,
            Err(error) => {
                return if html_connect_form {
                    security::GatewaySecurity::connect_error_response(&error)
                } else {
                    error_response(&error)
                };
            }
        };
    if request.method() == Method::OPTIONS && origin.allowed().is_some() {
        return security::preflight(&origin);
    }
    let mut response = if declared_body_too_large(&request) {
        if html_connect_form {
            security::GatewaySecurity::connect_error_response(&HttpError::PayloadTooLarge)
        } else {
            payload_too_large_response()
        }
    } else {
        match authorized_route(state, request, &origin).await {
            Ok(response) => response,
            Err(error) => {
                if html_connect_form {
                    security::GatewaySecurity::connect_error_response(&error)
                } else {
                    error_response(&error)
                }
            }
        }
    };
    security::apply_cors(&mut response, &origin);
    response
}

async fn authorized_route(
    state: Arc<HttpState>,
    mut request: Request<Body>,
    origin: &security::RequestOrigin,
) -> Result<Response, HttpError> {
    if matches!(*request.method(), Method::GET | Method::POST)
        && request.uri().path() == security::CONNECT_PATH
    {
        return security::connect_request(&state, request).await;
    }
    let grant = match state.security.authorize(
        &request,
        origin,
        state.devices.authenticate(request.headers()).as_ref(),
    )? {
        security::Admission::Respond(response) => return Ok(response),
        security::Admission::Granted(grant) => grant,
    };
    security::require_json_body(request.method(), request.uri().path(), request.headers())?;
    if request.method() == Method::POST && request.uri().path() == security::CONNECTION_CODES_PATH {
        return state
            .security
            .mint_connection_code(&grant, request.headers());
    }
    let peer = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|info| info.0);
    let client = Client {
        access: grant.access,
        local: security::is_local_client(peer, request.headers(), origin),
        admin: state.security.is_admin(request.headers()),
        keys: grant.keys,
    };
    request.extensions_mut().insert(client.clone());
    let signs = client.access.receives_signed_urls();
    let keys = client.keys.clone();
    let response = route_for_client(state, request, client).await?;
    Ok(if signs {
        keys.sign_urls(response).await
    } else {
        response
    })
}

/// The routes whose answer depends on who asks (Settings → Security, the
/// settings view, live streams), then every other route.
async fn route_for_client(
    state: Arc<HttpState>,
    request: Request<Body>,
    client: Client,
) -> Result<Response, HttpError> {
    let uri = request.uri().clone();
    if uri.path() == "/security" || uri.path().starts_with("/security/") {
        return security_settings::route(state, request).await;
    }
    match (request.method(), uri.path()) {
        (&Method::GET, "/settings") => settings::get(state, Some(client)).await,
        (&Method::GET, "/events/live") => {
            let scope = request
                .extensions()
                .get::<listeners::ListenerScope>()
                .cloned();
            get_live_events(state, &uri, scope, &client.keys).await
        }
        _ => route(state, request).await,
    }
}

async fn route(state: Arc<HttpState>, request: Request<Body>) -> Result<Response, HttpError> {
    let method = request.method().clone();
    let uri = request.uri().clone();
    let accepts_html = static_ui::accepts_html(request.headers());
    if matches!(
        uri.path(),
        "/session-view" | "/session-summary" | "/context-details"
    ) || uri.path().starts_with("/steward-relations/")
    {
        if let Some(response) = subsessions::route(state, request, &uri).await? {
            return Ok(response);
        }
        return Err(HttpError::public(404, "not_found", "Route not found."));
    }
    if uri.path().starts_with("/authority-requests")
        || uri.path().starts_with("/authority-permissions")
    {
        return authority::route(state, request, &uri).await;
    }
    if uri.path() == "/model-catalog" || uri.path().starts_with("/model-catalog/") {
        return model_catalog::route(state, request, &uri).await;
    }
    if personalization::settings_path(&uri) {
        return personalization::route(state, request, &uri).await;
    }
    if owner_memory::matches(uri.path()) {
        return owner_memory::route(state, request, &uri).await;
    }
    if matches!(
        uri.path(),
        "/usage-monitor"
            | "/work-status"
            | "/worker-activity"
            | "/system-events"
            | "/developer-logs"
    ) || uri.path().starts_with("/worker-activity/")
        || (uri.path().starts_with("/sessions/") && uri.path().contains("/worker-activity"))
    {
        return monitors::route(state, request, &uri).await;
    }
    if uri.path().starts_with("/space/") {
        if let Some(response) = space_mutations::route(state, request, &uri).await? {
            return Ok(response);
        }
        return Err(HttpError::public(404, "not_found", "Route not found."));
    }
    if uri.path().starts_with("/projects/") && uri.path().contains("/dashboard") {
        if let Some(response) = dashboard::route(state, request, &uri).await? {
            return Ok(response);
        }
        return Err(HttpError::public(404, "not_found", "Route not found."));
    }
    if uri.path().starts_with("/sessions/")
        && (uri.path().ends_with("/controls") || uri.path().contains("/plan-decisions/"))
    {
        if let Some(response) = session_controls::route(state, request, &uri).await? {
            return Ok(response);
        }
        return Err(HttpError::public(404, "not_found", "Route not found."));
    }
    if uri.path().starts_with("/projects/") || uri.path().starts_with("/sessions/") {
        if let Some(response) = project_session_mutations::route(state, request, &uri).await? {
            return Ok(response);
        }
        return Err(HttpError::public(404, "not_found", "Route not found."));
    }
    if method == Method::GET
        && matches!(
            uri.path(),
            "/app-info" | "/navigation" | "/command-palette" | "/archives"
        )
    {
        return shell::route(state, &uri).await;
    }
    if uri.path() == "/automations" || uri.path().starts_with("/automations/") {
        return automations::route(state, request, &uri).await;
    }
    if uri.path() == "/updates" || uri.path() == "/updates/check" || uri.path() == "/updates/apply"
    {
        return updates::route(state, request).await;
    }
    if message_files::handles(&method, uri.path()) {
        return message_files::route(state, request).await;
    }
    if wallpapers::handles(uri.path()) {
        return wallpapers::route(state, request).await;
    }
    if (method == Method::PATCH || method == Method::DELETE)
        && uri
            .path()
            .strip_prefix("/session-queue/")
            .is_some_and(|id| !id.is_empty() && !id.contains('/'))
    {
        return session_queue::route(state, request, &uri).await;
    }
    if uri.path() == "/mcp-servers"
        || uri.path() == "/mcp-capabilities"
        || uri.path().starts_with("/mcp-servers/")
    {
        return mcp_servers::route(state, request, &uri).await;
    }
    if uri.path().starts_with("/turns/") && uri.path().contains("/operations/") {
        if let Some(response) = operation_output::route(state, request, &uri).await? {
            return Ok(response);
        }
        return Err(HttpError::public(404, "not_found", "Route not found."));
    }
    if uri.path().starts_with("/turns/") && uri.path().contains("/retry") {
        if let Some(response) = retry::route(state, &method, &uri).await? {
            return Ok(response);
        }
        return Err(HttpError::public(404, "not_found", "Route not found."));
    }
    if let Some(response) = retry::cancel(&state, &method, &uri).await? {
        return Ok(response);
    }
    if setup::handles(uri.path()) {
        return setup::route(state, request, &uri).await;
    }
    match (method.clone(), uri.path()) {
        (Method::GET, "/health") => health(),
        (Method::GET, "/provider-quota") => monitors::provider_quota(state, &uri).await,
        (Method::GET, "/runtime-readiness") => {
            let mut readiness = state.application.runtime_readiness()?;
            readiness.raw_text_included = false;
            json(
                StatusCode::OK,
                ApiEnvelope {
                    protocol_version: APP_PROTOCOL_VERSION,
                    data: readiness,
                },
            )
        }
        (Method::PATCH, "/settings") => settings::patch(state, request).await,
        (Method::GET, "/skills") => skills::get(state).await,
        (Method::POST, "/skills/import") => skills::import(state, request).await,
        (Method::POST, "/messages") => post_message(state, request).await,
        (Method::POST, "/internal/subsession-result") => {
            subsession_result::post(state, request).await
        }
        (Method::POST, "/internal/session-branches") => {
            session_branches::post(state, request).await
        }
        (Method::GET, "/projects") => projects::list(state, &uri).await,
        (Method::GET, "/new-chat-briefing") => new_chat_briefing::get(state, &uri).await,
        (Method::POST, "/projects") => projects::create(state, request).await,
        (Method::GET, "/chats") => sessions::chats(state).await,
        (Method::GET, "/sessions") => sessions::list(state, &uri).await,
        (Method::GET, "/project-sessions") => sessions::project_list(state, &uri).await,
        (Method::POST, "/sessions") => sessions::create(state, request).await,
        (Method::GET, "/messages") => get_messages(state, &uri).await,
        (Method::GET, "/artifacts") => get_artifacts(state, &uri).await,
        (Method::GET, "/transcript-export") => transcript_export::get(state, &uri).await,
        (Method::GET, "/session-queue") => get_session_queue(state, &uri).await,
        (Method::POST, "/session-queue") => session_queue::create(state, request).await,
        (Method::GET, "/turns") => get_turns(state, &uri).await,
        (Method::GET, "/events") => get_events(state, &uri).await,
        _ if method == Method::GET => {
            static_ui::serve(state.static_ui_root.as_deref(), uri.path(), accepts_html).await
        }
        _ => Err(HttpError::public(404, "not_found", "Route not found.")),
    }
}

async fn post_message(
    state: Arc<HttpState>,
    request: Request<Body>,
) -> Result<Response, HttpError> {
    let bytes = read_body_with_limit(request.into_body(), MAX_REQUEST_BODY_SIZE).await?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| HttpError::invalid_json())?;
    drop(bytes);
    let message = validate_message_request(&value).map_err(|error| match error {
        MessageRequestError::Invalid => {
            HttpError::public(400, "invalid_request", "Message text is required.")
        }
        MessageRequestError::AuthorityProperty => HttpError::public(
            400,
            "invalid_request",
            "Authority decisions must use the Allow endpoint.",
        ),
        MessageRequestError::SubsessionProperty => HttpError::public(
            400,
            "invalid_request",
            "Subsession results must use the internal result endpoint.",
        ),
    })?;
    let chat_id = match message.chat_id.as_ref() {
        None | Some(Value::Null) => "general".to_owned(),
        Some(Value::String(value)) if value.trim().is_empty() => "general".to_owned(),
        Some(Value::String(value)) => value.trim().to_owned(),
        Some(_) => return Err(HttpError::Internal),
    };
    if !state.limiter.consume(format!("messages:{chat_id}")) {
        return Err(HttpError::public(
            429,
            "rate_limited",
            "Too many messages. Please wait before sending again.",
        ));
    }
    let result = state
        .application
        .send_message(SendMessageCommand {
            request: message,
            chat_id,
        })
        .await?;
    json(
        StatusCode::ACCEPTED,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data: result,
        },
    )
}

fn declared_body_too_large(request: &Request<Body>) -> bool {
    request
        .headers()
        .get_all(header::CONTENT_LENGTH)
        .iter()
        .filter_map(|value| value.to_str().ok()?.parse::<u128>().ok())
        .any(|length| length > MAX_REQUEST_BODY_SIZE as u128)
}

fn payload_too_large_response() -> Response {
    let mut response = Response::new(Body::empty());
    *response.status_mut() = StatusCode::PAYLOAD_TOO_LARGE;
    response
        .headers_mut()
        .insert(header::CONNECTION, HeaderValue::from_static("close"));
    response
}

pub(super) async fn read_body_with_limit(body: Body, limit: usize) -> Result<Bytes, HttpError> {
    to_bytes(body, limit)
        .await
        .map_err(classify_body_read_error)
}

#[expect(
    clippy::needless_pass_by_value,
    reason = "map_err/iterator adapter taking owned values"
)]
fn classify_body_read_error(error: axum::Error) -> HttpError {
    let mut source: &(dyn StdError + 'static) = &error;
    loop {
        if source.is::<LengthLimitError>() {
            return HttpError::PayloadTooLarge;
        }
        let Some(next) = source.source() else {
            return HttpError::invalid_json();
        };
        source = next;
    }
}
