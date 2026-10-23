//! Structured logging HTTP adapters; all filesystem work stays off Tokio workers.
use super::{HttpError, HttpState, json, query, read_body_with_limit};
use crate::gateway::protocol::{APP_PROTOCOL_VERSION, ApiEnvelope};
use axum::{
    body::Body,
    http::{Method, Request, StatusCode, Uri},
    response::{Response, Sse, sse::Event},
};
use serde_json::{Value, json as value};
use std::{io, sync::Arc};

pub(super) async fn initialize(
    application: Arc<dyn crate::gateway::GatewayApplication>,
    shutdown: tokio_util::sync::CancellationToken,
) -> Result<(), HttpError> {
    let Some(log) = butler_log::global().cloned() else {
        return Ok(());
    };
    let mut settings = application.read_settings().await?;
    if settings["log_level"] == "full" {
        let previous = settings
            .pointer("/log_full/previous")
            .and_then(Value::as_str)
            .filter(|v| *v != "full")
            .unwrap_or("standard");
        settings = application
            .update_settings(value!({"log_level":previous}))
            .await?;
    }
    let config = butler_log::Config::from_settings(&settings);
    let mut changes = log.config_changes();
    blocking(move || log.configure(config)).await?;
    tokio::spawn(async move {
        loop {
            tokio::select! {
                ()=shutdown.cancelled()=>break,
                changed=changes.changed()=> {
                    if changed.is_err() { break; }
                    let view=changes.borrow_and_update().clone();
                    if view.full_expires_at.is_none()
                        && let Ok(stored)=application.read_settings().await
                        && stored["log_level"]=="full" {
                        let _=application.update_settings(value!({"log_level":view.effective.level})).await;
                    }
                }
            }
        }
    });
    Ok(())
}
pub(super) async fn route(
    state: Arc<HttpState>,
    request: Request<Body>,
    uri: &Uri,
) -> Result<Response, HttpError> {
    let settings = state.application.read_settings().await?;
    let developer = settings["diagnostics_enabled"] == true;
    if !(developer || request.method() == Method::POST && uri.path() == "/logs/export") {
        return Err(HttpError::public(
            403,
            "developer_mode_required",
            "Developer mode is required.",
        ));
    }
    let log = butler_log::global().cloned().ok_or(HttpError::Internal)?;
    match (request.method(), uri.path()) {
        (&Method::GET, "/logs") => {
            let q = parse_query(uri)?;
            envelope(
                serde_json::to_value(blocking(move || log.query(&q)).await?)
                    .map_err(|_| HttpError::Internal)?,
            )
        }
        (&Method::GET, path) if path == "/logs/trace" || path.starts_with("/logs/trace/") => {
            let parameters = query(uri);
            let id = path.strip_prefix("/logs/trace/").map(str::to_owned);
            let result = blocking(move || match id {
                Some(id) => log.trace(&id),
                None => log.resolve_trace(
                    parameters.get("turn_id").cloned(),
                    parameters.get("chat_id").cloned(),
                    parameters.get("message_id").map(String::as_str),
                ),
            })
            .await?;
            envelope(serde_json::to_value(result).map_err(|_| HttpError::Internal)?)
        }
        (&Method::GET, "/logs/config") => {
            envelope(serde_json::to_value(log.config()).map_err(|_| HttpError::Internal)?)
        }
        (&Method::PUT, "/logs/config") => configure(state, request, log).await,
        (&Method::GET, "/logs/storage") => envelope(
            serde_json::to_value(blocking(move || log.storage()).await?)
                .map_err(|_| HttpError::Internal)?,
        ),
        (&Method::DELETE, "/logs") => {
            let freed = blocking(move || log.clear()).await?;
            state
                .application
                .publish_gateway_event("logs.cleared", serde_json::Map::new())
                .await?;
            envelope(value!({"agent_freed_bytes":freed}))
        }
        (&Method::GET, "/logs/live") => live(&log, &state, request).await,
        (&Method::POST, "/logs/export") => export(request, log, developer).await,
        (&Method::GET, path) if path.starts_with("/logs/bodies/") => {
            let reference =
                super::monitors::decode_component(path.trim_start_matches("/logs/bodies/"))?;
            let bytes = blocking(move || log.body(&reference)).await?;
            Response::builder()
                .header("content-type", "application/octet-stream")
                .body(Body::from(bytes))
                .map_err(|_| HttpError::Internal)
        }
        _ => Err(HttpError::public(404, "not_found", "Route not found.")),
    }
}
async fn configure(
    state: Arc<HttpState>,
    request: Request<Body>,
    log: butler_log::Logger,
) -> Result<Response, HttpError> {
    let bytes = read_body_with_limit(request.into_body(), 64 * 1024).await?;
    let mut config: butler_log::Config =
        serde_json::from_slice(&bytes).map_err(|_| HttpError::invalid_json())?;
    if !config.valid() {
        return Err(HttpError::public(
            400,
            "invalid_log_config",
            "Invalid log configuration.",
        ));
    }
    for level in config.category_levels.values_mut() {
        level.make_ascii_lowercase();
    }
    let previous = log.config().effective;
    state
        .application
        .update_settings(
            value!({"log_level":config.level,"log_category_levels":config.category_levels}),
        )
        .await?;
    let mut view = log.config();
    if view.effective == previous {
        view.freed_bytes = 0;
    }
    envelope(serde_json::to_value(view).map_err(|_| HttpError::Internal)?)
}
async fn developer_subscription(
    state: &HttpState,
) -> Result<
    (
        tokio_util::sync::CancellationToken,
        Box<dyn crate::gateway::EventSubscription>,
    ),
    HttpError,
> {
    let disabled = tokio_util::sync::CancellationToken::new();
    let cancel = disabled.clone();
    // Subscribe before the snapshot so a concurrent disable cannot be missed.
    let subscription = state.application.subscribe_events(Arc::new(move |event| {
        let event = event.envelope();
        if event.event_type == "settings.updated"
            && event
                .payload
                .get("settings")
                .and_then(|s| s.get("diagnostics_enabled"))
                == Some(&Value::Bool(false))
        {
            cancel.cancel();
        }
    }))?;
    if state.application.read_settings().await?["diagnostics_enabled"] != true {
        disabled.cancel();
    }
    Ok((disabled, subscription))
}
async fn live(
    log: &butler_log::Logger,
    state: &HttpState,
    request: Request<Body>,
) -> Result<Response, HttpError> {
    let (disabled, subscription) = developer_subscription(state).await?;
    use futures_util::StreamExt;
    let mut closers = vec![state.shutdown.clone(), disabled];
    closers.extend(
        request
            .extensions()
            .get::<super::Client>()
            .map(|client| client.keys.live_streams()),
    );
    closers.extend(
        request
            .extensions()
            .get::<super::listeners::ListenerScope>()
            .map(|scope| scope.closed.clone()),
    );
    use axum::response::IntoResponse;
    let stream = futures_util::stream::unfold(log.subscribe(), |mut receiver| async move {
        match receiver.recv().await {
            Ok(row) => Some((
                Ok::<_, std::convert::Infallible>(
                    Event::default()
                        .event("log")
                        .data(serde_json::to_string(&row).unwrap_or_default()),
                ),
                receiver,
            )),
            Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => Some((
                Ok(Event::default().event("lagged").data(n.to_string())),
                receiver,
            )),
            Err(tokio::sync::broadcast::error::RecvError::Closed) => None,
        }
    });
    let stream = stream.take_until(async move {
        let _subscription = subscription;
        futures_util::future::select_all(
            closers
                .into_iter()
                .map(|closer| Box::pin(closer.cancelled_owned())),
        )
        .await;
    });
    Ok(Sse::new(stream).into_response())
}
async fn export(
    request: Request<Body>,
    log: butler_log::Logger,
    developer: bool,
) -> Result<Response, HttpError> {
    let bytes = read_body_with_limit(request.into_body(), 64 * 1024).await?;
    let input: Value = serde_json::from_slice(&bytes).map_err(|_| HttpError::invalid_json())?;
    let file = blocking(move || {
        log.export_file(
            input["since"].as_str(),
            input["until"].as_str(),
            developer && input["include_bodies"] == true,
        )
    })
    .await?;
    Response::builder()
        .header("content-type", "application/zip")
        .header(
            "content-disposition",
            "attachment; filename=butler-logs.zip",
        )
        .body(file_stream(file))
        .map_err(|_| HttpError::Internal)
}
fn file_stream(file: std::fs::File) -> Body {
    use tokio::io::AsyncReadExt;
    let stream =
        futures_util::stream::try_unfold(tokio::fs::File::from_std(file), |mut file| async move {
            let mut bytes = vec![0; 64 * 1024];
            let n = file.read(&mut bytes).await?;
            bytes.truncate(n);
            Ok::<_, io::Error>(if n == 0 { None } else { Some((bytes, file)) })
        });
    Body::from_stream(stream)
}
fn parse_query(uri: &Uri) -> Result<butler_log::Query, HttpError> {
    let parameters = query(uri);
    let mut value = serde_json::Map::new();
    for (key, v) in parameters {
        if key == "limit" {
            value.insert(
                key,
                Value::from(v.parse::<usize>().map_err(|_| HttpError::invalid_json())?),
            );
        } else {
            value.insert(key, Value::String(v));
        }
    }
    serde_json::from_value(Value::Object(value)).map_err(|_| HttpError::invalid_json())
}
fn envelope(data: Value) -> Result<Response, HttpError> {
    json(
        StatusCode::OK,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data,
        },
    )
}
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> io::Result<T> + Send + 'static,
) -> Result<T, HttpError> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|_| HttpError::Internal)?
        .map_err(|e| match e.kind() {
            io::ErrorKind::InvalidInput => {
                HttpError::public(400, "invalid_log_request", "Invalid log request.")
            }
            io::ErrorKind::NotFound => HttpError::public(404, "log_not_found", "Log has expired."),
            _ => HttpError::Internal,
        })
}
#[cfg(feature = "e2e-fixtures")]
pub(super) async fn expire() -> Result<Response, HttpError> {
    let log = butler_log::global().cloned().ok_or(HttpError::Internal)?;
    blocking(move || {
        log.expire_full()?;
        log.flush()
    })
    .await?;
    envelope(value!({}))
}

#[cfg(feature = "e2e-fixtures")]
pub(super) mod writer_fixture;
