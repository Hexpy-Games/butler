mod data_reset;
mod reset_secrets;
pub use reset_secrets::reset_browser_secret_keys;
mod assets;
mod authority;
mod authority_permissions;
mod body;
mod browser_host;
mod browser_stills;
mod content;
mod documents;
#[cfg(feature = "e2e-fixtures")]
mod image_fixtures;
mod image_models;
mod library;
mod pending_asks;
mod start;
pub(super) use start::serve;
mod access_log;
mod agent_import;
mod automations;
mod browser_import;
mod dashboard;
mod error;
mod favicons;
mod hooks;
mod latency_trace;
mod listeners;
mod logs;
mod mcp_servers;
mod memory_management;
mod message_files;
mod model_catalog;
mod monitors;
mod new_chat_briefing;
mod opened_files;
mod operation_output;
mod params;
mod personalization;
mod project_session_mutations;
mod projects;
mod read_routes;
mod retry;
mod router;
#[cfg(feature = "test-support")]
pub(crate) use router::templates as route_templates;
mod security;
pub(super) use security::RequestPolicy;
mod canon;
mod canon_proposals;
mod canon_sidebar;
mod security_settings;
mod session_branches;
mod session_controls;
mod session_queue;
mod sessions;
mod settings;
mod setup;
mod shell;
mod signin_secrets;
mod signins;
mod skills;
mod space_mutations;
mod static_ui;
mod subsession_result;
mod subsessions;
mod task_graphs;
mod transcript_export;
mod updates;
mod wallpaper_modules;
mod wallpapers;

use std::{net::SocketAddr, path::PathBuf, sync::Arc};

use axum::{
    body::Body,
    extract::{ConnectInfo, State},
    http::{Method, Request, StatusCode, Uri, header},
    response::Response,
};
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
pub(super) use body::read_body_with_limit;
use body::{MAX_REQUEST_BODY_SIZE, declared_body_too_large, payload_too_large_response};

struct HttpState {
    browser: Arc<browser_host::Hub>,
    headless: Option<Arc<butler_runtime::browser::Headless>>,
    /// The installed App's Electron as a windowless browser host.
    app_host: Option<Arc<butler_runtime::browser::AppHost>>,
    previews: butler_runtime::previews::Previews,
    preview_lifetime_started: parking_lot::Mutex<bool>,
    devices: security::DeviceRegistry,
    application: Arc<dyn GatewayApplication>,
    security: security::GatewaySecurity,
    remote: listeners::RemoteAccess,
    security_store: Option<Arc<dyn GatewaySecurityStore>>,
    session_cursor_secret: String,
    limiter: FixedWindowRateLimiter,
    shutdown: CancellationToken,
    favicons: Arc<favicons::Favicons>,
    uploads: tokio::sync::Semaphore,
    static_ui_root: Option<PathBuf>,
    output_data: Option<PathBuf>,
    signin_secrets: signin_secrets::SignInSecrets,
    browser_import: browser_import::ImportSessions,
    import_dependencies: butler_platform::browser_transfer::ImportDependencies,
    agent_imports: agent_import::AgentImports,
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
    let started = std::time::Instant::now();
    let method = request.method().clone();
    let route = request
        .extensions()
        .get::<axum::extract::MatchedPath>()
        .cloned();
    let action = request
        .extensions()
        .get::<router::Handler>()
        .and_then(|h| h.action(&method));
    let admitted = access_log::Admission::default();
    let mut request = request;
    request.extensions_mut().insert(admitted.clone());
    use tracing::Instrument;
    let context = request
        .headers()
        .get("traceparent")
        .and_then(|h| h.to_str().ok())
        .and_then(butler_log::TraceContext::from_traceparent)
        .unwrap_or_default();
    let level = if matches!(method, Method::GET | Method::HEAD | Method::OPTIONS) {
        "DEBUG"
    } else {
        "INFO"
    };
    let span = context.http_span(level);
    async {
        let response = dispatch_inner(state, request).await;
        if admitted.is_granted() {
            tracing::Span::current().record("action", action);
        }
        access_log::finish(
            &method,
            route.as_ref(),
            &admitted,
            response.status(),
            started,
        )
        .await;
        response
    }
    .instrument(span)
    .await
}

async fn dispatch_inner(state: Arc<HttpState>, request: Request<Body>) -> Response {
    let timing = latency_trace::start(&request);
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
        match authorized_route(state.clone(), request, &origin).await {
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
    content::admit_ui_frames(&state, &mut response);
    latency_trace::finish(timing, &mut response);
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
        return security::connect_request(&state, request, origin).await;
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
    if let Some(admitted) = request.extensions().get::<access_log::Admission>() {
        admitted.grant();
    }
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
    let application = state.application.clone();
    let response = route_for_client(state, request, client).await?;
    Ok(if signs {
        keys.sign_urls(response, application.as_ref()).await
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
    router::route(state, request, client).await
}

async fn route(
    state: Arc<HttpState>,
    request: Request<Body>,
    handler: router::Handler,
) -> Result<Response, HttpError> {
    let method = request.method().clone();
    let uri = request.uri().clone();
    let accepts_html = static_ui::accepts_html(request.headers());
    match (method.clone(), handler) {
        (Method::GET, router::Handler::Health) => health(&state),
        (Method::GET, router::Handler::ProviderQuota) => {
            monitors::provider_quota(state, &uri).await
        }
        (Method::GET, router::Handler::RuntimeReadiness) => {
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
        (Method::PATCH, router::Handler::Settings) => settings::patch(state, request).await,
        (Method::GET, router::Handler::Skills) => skills::get(state).await,
        (Method::POST, router::Handler::SkillsImport) => skills::import(state, request).await,
        (Method::POST, router::Handler::Messages) => post_message(state, request).await,
        (Method::POST, router::Handler::InternalSubsessionResult) => {
            subsession_result::post(state, request).await
        }
        (Method::POST, router::Handler::InternalSessionBranches) => {
            session_branches::post(state, request).await
        }
        (Method::GET, router::Handler::Projects) => projects::list(state, &uri).await,
        (Method::GET, router::Handler::ProjectFolders) => projects::folders(state, &uri).await,
        (Method::GET, router::Handler::NewChatBriefing) => {
            new_chat_briefing::get(state, &uri).await
        }
        (Method::POST, router::Handler::Projects) => projects::create(state, request).await,
        (Method::GET, router::Handler::Chats) => sessions::chats(state, &uri).await,
        (Method::GET, router::Handler::Sessions) => sessions::list(state, &uri).await,
        (Method::GET, router::Handler::ProjectSessions) => {
            sessions::project_list(state, &uri).await
        }
        (Method::POST, router::Handler::Sessions) => sessions::create(state, request).await,
        (Method::GET, router::Handler::Messages) => get_messages(state, &uri).await,
        (Method::GET, router::Handler::Artifacts) => get_artifacts(state, &uri).await,
        (Method::GET, router::Handler::TranscriptExport) => {
            transcript_export::get(state, &uri).await
        }
        (Method::GET, router::Handler::SessionQueue) => get_session_queue(state, &uri).await,
        (Method::POST, router::Handler::SessionQueue) => {
            session_queue::create(state, request).await
        }
        (Method::GET, router::Handler::Turns) => get_turns(state, &uri).await,
        (Method::GET, router::Handler::Events) => get_events(state, &uri).await,
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

mod connectors;
mod plugins;
