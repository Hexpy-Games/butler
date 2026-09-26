mod authority;
mod automations;
mod dashboard;
mod dev_cors;
mod error;
mod mcp_servers;
mod message_files;
mod model_catalog;
mod monitors;
mod new_chat_briefing;
mod operation_output;
mod personalization;
mod project_session_mutations;
mod projects;
mod read_routes;
mod retry;
mod session_branches;
mod session_controls;
mod session_queue;
mod sessions;
mod settings;
mod shell;
mod skills;
mod space_mutations;
mod static_ui;
mod subsession_result;
mod subsessions;
mod transcript_export;
mod updates;

use std::{collections::HashMap, error::Error as StdError, path::PathBuf, sync::Arc};

use axum::{
    Router,
    body::{Body, Bytes, to_bytes},
    extract::{DefaultBodyLimit, Query, State},
    http::{Method, Request, StatusCode, Uri, header},
    response::Response,
    routing::any,
};
use http_body_util::LengthLimitError;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::{
    EventReplayView, GatewayApplication, GatewayConfig, HealthView, SendMessageCommand,
    auth::{self, LocalAuthConfig},
    live::create_live_stream,
    message_validation::{MessageRequestError, validate_message_request},
    protocol::{APP_PROTOCOL_VERSION, ApiEnvelope},
    rate_limit::FixedWindowRateLimiter,
};
pub(super) use error::HttpError;
use error::{error_response, json};
use read_routes::{
    get_artifacts, get_events, get_live_events, get_messages, get_session_queue, get_turns,
};

const DEFAULT_PAGE_LIMIT: usize = 200;
const MAX_REQUEST_BODY_SIZE: usize = 128 * 1024 * 1024;

pub(super) fn router(
    application: Arc<dyn GatewayApplication>,
    config: GatewayConfig,
    shutdown: CancellationToken,
) -> Router {
    let limiter = FixedWindowRateLimiter::new(
        config.message_rate_limit_max,
        config.message_rate_limit_window,
    );
    Router::new()
        .fallback(any(dispatch))
        .with_state(Arc::new(HttpState {
            application,
            auth: config.local_auth,
            dev_cors: dev_cors::DevCorsPolicy::new(config.dev_cors_origin.as_deref()),
            session_cursor_secret: uuid::Uuid::new_v4().to_string(),
            limiter,
            shutdown,
            uploads: tokio::sync::Semaphore::new(2),
            static_ui_root: config.static_ui_root,
        }))
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BODY_SIZE))
}

struct HttpState {
    application: Arc<dyn GatewayApplication>,
    auth: LocalAuthConfig,
    dev_cors: dev_cors::DevCorsPolicy,
    session_cursor_secret: String,
    limiter: FixedWindowRateLimiter,
    shutdown: CancellationToken,
    uploads: tokio::sync::Semaphore,
    static_ui_root: Option<PathBuf>,
}

async fn dispatch(State(state): State<Arc<HttpState>>, request: Request<Body>) -> Response {
    let origin = state.dev_cors.allowed_origin(request.headers());
    if request.method() == Method::OPTIONS
        && let Some(origin) = origin.as_ref()
    {
        return dev_cors::preflight(origin);
    }
    if declared_body_too_large(&request) {
        let mut response = payload_too_large_response();
        dev_cors::apply(&mut response, origin.as_ref());
        return response;
    }
    let mut response = match route(state, request).await {
        Ok(response) => response,
        Err(error) => error_response(error),
    };
    dev_cors::apply(&mut response, origin.as_ref());
    response
}

async fn route(state: Arc<HttpState>, request: Request<Body>) -> Result<Response, HttpError> {
    if !static_ui::is_public_static_request(request.method(), request.uri().path()) {
        auth::enforce(request.headers(), &state.auth)?;
    }
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
    if uri.path() == "/personalization" || uri.path().starts_with("/personalization/") {
        return personalization::route(state, request, &uri).await;
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
    if (method == Method::POST && uri.path() == "/message-files")
        || (method == Method::GET
            && uri
                .path()
                .strip_prefix("/message-files/")
                .is_some_and(|id| !id.is_empty() && !id.contains('/')))
    {
        return message_files::route(state, request).await;
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
    if method == Method::POST
        && let Some(turn_id) = uri
            .path()
            .strip_prefix("/turns/")
            .and_then(|value| value.strip_suffix("/cancel"))
            .filter(|value| !value.is_empty() && !value.contains('/'))
    {
        let result = state
            .application
            .cancel_turn(subsessions::decode_component(turn_id)?)
            .await?;
        return json(
            StatusCode::ACCEPTED,
            ApiEnvelope {
                protocol_version: APP_PROTOCOL_VERSION,
                data: result,
            },
        );
    }
    match (method.clone(), uri.path()) {
        (Method::GET, "/health") => json(
            StatusCode::OK,
            ApiEnvelope {
                protocol_version: APP_PROTOCOL_VERSION,
                data: HealthView {
                    ok: true,
                    service: "butler-app-server".to_owned(),
                    protocol_version: APP_PROTOCOL_VERSION.to_owned(),
                },
            },
        ),
        (Method::GET, "/runtime-readiness") => {
            let mut readiness = state.application.runtime_readiness()?;
            readiness.authenticated_gateway_ready = true;
            readiness.raw_text_included = false;
            json(
                StatusCode::OK,
                ApiEnvelope {
                    protocol_version: APP_PROTOCOL_VERSION,
                    data: readiness,
                },
            )
        }
        (Method::GET, "/settings") => settings::get(state).await,
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
        (Method::GET, "/events/live") => get_live_events(state, &uri).await,
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
    let message = validate_message_request(value).map_err(|error| match error {
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

fn query(uri: &Uri) -> HashMap<String, String> {
    Query::<Vec<(String, String)>>::try_from_uri(uri)
        .map(|query| {
            query
                .0
                .into_iter()
                .fold(HashMap::new(), |mut values, (key, value)| {
                    values.entry(key).or_insert(value);
                    values
                })
        })
        .unwrap_or_default()
}

fn cursor_param(value: Option<&String>) -> f64 {
    value
        .and_then(|value| javascript_number(value))
        .filter(|value| value.is_finite())
        .unwrap_or(0.0)
}

fn limit_param(value: Option<&String>) -> usize {
    value
        .and_then(|value| javascript_number(value))
        .filter(|value| value.is_finite())
        .map_or(DEFAULT_PAGE_LIMIT, |value| {
            value.floor().clamp(1.0, DEFAULT_PAGE_LIMIT as f64) as usize
        })
}

fn javascript_number(value: &str) -> Option<f64> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Some(0.0);
    }
    let integer = if let Some(digits) = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
    {
        u64::from_str_radix(digits, 16).ok()
    } else if let Some(digits) = trimmed
        .strip_prefix("0b")
        .or_else(|| trimmed.strip_prefix("0B"))
    {
        u64::from_str_radix(digits, 2).ok()
    } else if let Some(digits) = trimmed
        .strip_prefix("0o")
        .or_else(|| trimmed.strip_prefix("0O"))
    {
        u64::from_str_radix(digits, 8).ok()
    } else {
        return trimmed.parse::<f64>().ok().or_else(|| {
            matches!(trimmed, "Infinity" | "+Infinity")
                .then_some(f64::INFINITY)
                .or_else(|| (trimmed == "-Infinity").then_some(f64::NEG_INFINITY))
        });
    };
    integer.map(|number| number as f64)
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
        .insert(header::CONNECTION, "close".parse().unwrap());
    response
}

pub(super) async fn read_body_with_limit(body: Body, limit: usize) -> Result<Bytes, HttpError> {
    to_bytes(body, limit)
        .await
        .map_err(classify_body_read_error)
}

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
