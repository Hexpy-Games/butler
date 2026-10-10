//! Main-only, ephemeral output-check transport. No event log, files or polling.
pub(super) mod agent_calls;
mod downloads;
mod previews;
mod report;
mod usage;
use super::{Client, HttpError, HttpState};
use axum::{
    body::Body,
    http::{Method, Request, StatusCode},
    response::{
        Response,
        sse::{Event, KeepAlive, Sse},
    },
};
use futures_util::stream;
pub(super) use previews::observe_lifetime;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{mpsc, oneshot};

#[derive(Default)]
pub(super) struct Hub(Mutex<Inner>, tokio::sync::Mutex<()>);
#[derive(Default)]
struct Inner {
    host: Option<mpsc::Sender<Value>>,
    pending: HashMap<String, oneshot::Sender<Value>>,
    tabs: butler_runtime::browser::TabRegistry,
    uses: HashMap<String, usage::Use>,
    turns: HashSet<(String, String)>,
}
struct HostStream {
    state: Arc<HttpState>,
    receiver: mpsc::Receiver<Value>,
    _subscription: Box<dyn crate::gateway::EventSubscription>,
}
impl Drop for HostStream {
    fn drop(&mut self) {
        if let Ok(mut hub) = self.state.browser.0.lock() {
            hub.host = None;
            hub.pending.clear();
            hub.tabs.clear();
            hub.uses.clear();
            hub.turns.clear();
        }
    }
}
fn error(status: u16, code: &'static str) -> HttpError {
    HttpError::public(status, code, "Browser check unavailable.")
}
pub(super) async fn route(
    state: Arc<HttpState>,
    request: Request<Body>,
    client: &Client,
) -> Result<Response, HttpError> {
    use subtle::ConstantTimeEq;
    let bearer = request
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    let authenticated = state.security.token().is_some_and(|token| {
        bearer.is_some_and(|sent| bool::from(sent.as_bytes().ct_eq(token.as_bytes())))
    });
    if !client.local || !client.admin || !authenticated {
        return Err(error(403, "browser_host_forbidden"));
    }
    let path = request.uri().path().to_owned();
    match (request.method(), path.as_str()) {
        (&Method::GET, "/internal/browser-host") => attach(state, client.keys.live_streams()),
        (&Method::POST, "/internal/browser-host/downloads") => {
            downloads::handle(state, read_json(request).await?).await
        }
        (&Method::POST, "/internal/browser/calls") => call(state, request).await,
        (&Method::POST, "/internal/browser-host/stills") => {
            agent_calls::still(state, read_json(request).await?).await
        }
        (&Method::POST, "/internal/browser-host/events") => {
            agent_calls::events(state, read_json(request).await?).await
        }
        (&Method::POST, p) if p.starts_with("/internal/browser-host/results/") => {
            let id = p.trim_start_matches("/internal/browser-host/results/");
            let body = read_json(request).await?;
            let sender = state
                .browser
                .0
                .lock()
                .map_err(|_| HttpError::Internal)?
                .pending
                .remove(id);
            let Some(sender) = sender else {
                return Err(error(409, "browser_call_expired"));
            };
            let _ = sender.send(body);
            super::json(StatusCode::OK, json!({"ok":true}))
        }
        _ => Err(error(404, "not_found")),
    }
}
fn attach(
    state: Arc<HttpState>,
    rotated: tokio_util::sync::CancellationToken,
) -> Result<Response, HttpError> {
    let (sender, receiver) = mpsc::channel(8);
    {
        let mut hub = state.browser.0.lock().map_err(|_| HttpError::Internal)?;
        if hub.host.is_some() {
            return Err(error(409, "browser_host_exists"));
        }
        hub.host = Some(sender);
    }
    let weak = Arc::downgrade(&state);
    // Committed events are published on the SQLite owner thread, not Tokio.
    let runtime = tokio::runtime::Handle::current();
    let subscription = state.application.subscribe_events(Arc::new(move |event| {
        let envelope = event.envelope();
        if envelope.event_type == "subsession.changed" {
            usage::finish_child(weak.clone(), &runtime, &envelope.payload);
            return;
        }
        if envelope.event_type != "turn.state_changed" {
            return;
        }
        let Some(state) = weak.upgrade() else {
            return;
        };
        usage::finish_turn(&state, &envelope.payload);
        let turn = envelope
            .payload
            .get("turn")
            .and_then(Value::as_object)
            .unwrap_or(&envelope.payload);
        if turn.get("state").and_then(Value::as_str) != Some("waiting_for_form") {
            return;
        }
        runtime.spawn(async move {
            let tabs = state
                .browser
                .0
                .lock()
                .map(|hub| hub.tabs.ready_waits())
                .unwrap_or_default();
            let _ = agent_calls::resume_waits(&state, &tabs).await;
        });
    }))?;
    let shutdown = state.shutdown.clone();
    let stream = stream::unfold(
        HostStream {
            state,
            receiver,
            _subscription: subscription,
        },
        move |mut host| {
            let shutdown = shutdown.clone();
            let rotated = rotated.clone();
            async move {
                tokio::select! {
                    () = shutdown.cancelled() => None,
                    () = rotated.cancelled() => None,
                    frame = host.receiver.recv() => frame.map(|v| (Ok::<_, std::convert::Infallible>(Event::default().event("call").data(v.to_string())), host)),
                }
            }
        },
    );
    use axum::response::IntoResponse;
    Ok(Sse::new(stream)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(60)))
        .into_response())
}
async fn call(state: Arc<HttpState>, request: Request<Body>) -> Result<Response, HttpError> {
    let mut args = read_json(request).await?;
    if args["op"]
        .as_str()
        .is_some_and(|op| op.starts_with("preview."))
    {
        return previews::call(state, args).await;
    }
    if args.get("op").is_some() {
        return agent_calls::call(state, args).await;
    }
    let view = super::content::check_view(&state, &args).await?;
    args["url"] = view["url"].clone();
    args["revision"] = view["revision"].clone();
    let id = uuid::Uuid::new_v4().to_string();
    let (sender, receiver) = oneshot::channel();
    {
        let mut hub = state.browser.0.lock().map_err(|_| HttpError::Internal)?;
        let Some(host) = hub.host.as_ref() else {
            return super::json(
                StatusCode::OK,
                json!({"status":"unavailable","reason":"no_browser"}),
            );
        };
        if hub.pending.len() >= 8 {
            return Err(error(429, "browser_busy"));
        }
        host.try_send(json!({"id":id,"lease":{"id":id,"kind":"output_check","content_origin":url::Url::parse(args["url"].as_str().unwrap_or("")).map_err(|_| error(400,"invalid_request"))?.origin().ascii_serialization()},"op":"output.check","args":args,"deadline_ms":7500}))
            .map_err(|_| error(429, "browser_busy"))?;
        hub.pending.insert(id.clone(), sender);
    }
    let _pending = PendingCall {
        state: state.clone(),
        id: id.clone(),
    };
    let result = tokio::select! {
        () = state.shutdown.cancelled() => json!({"status":"unknown","reason":"browser_host_lost"}),
        result = tokio::time::timeout(Duration::from_secs(8), receiver) => match result {
            Ok(Ok(value)) => {
                if value["status"] == "ok" && !allowed_result_url(&value, &args) {
                    json!({"status":"navigation_denied"})
                } else {
                    let mut report = report::shape(&value);
                    if args["include_image"] != true && let Some(r) = report.as_object_mut() { r.remove("image"); }
                    if args["include_image"] == true && report.get("image").is_none() && report["status"] != "unknown" {
                        report["status"] = json!("unknown");
                        report["reason"] = json!("image_unavailable");
                    }
                    report
                }
            },
            Ok(Err(_)) => json!({"status":"unknown","reason":"browser_host_lost"}),
            Err(_) => json!({"status":"unknown","reason":"timeout"}),
        }
    };
    super::json(StatusCode::OK, result)
}

async fn read_json(request: Request<Body>) -> Result<Value, HttpError> {
    let limit = if request
        .uri()
        .path()
        .starts_with("/internal/browser-host/results/")
    {
        256 * 1024
    } else {
        64 * 1024
    };
    let bytes = super::read_body_with_limit(request.into_body(), limit).await?;
    serde_json::from_slice(&bytes).map_err(|_| error(400, "invalid_request"))
}

struct PendingCall {
    state: Arc<HttpState>,
    id: String,
}
impl Drop for PendingCall {
    fn drop(&mut self) {
        if let Ok(mut hub) = self.state.browser.0.lock() {
            usage::release(&mut hub, &self.id);
        }
    }
}

fn allowed_result_url(value: &Value, args: &Value) -> bool {
    let parse = |v: &Value| v.as_str().and_then(|s| url::Url::parse(s).ok());
    parse(&value["url"])
        .zip(parse(&args["url"]))
        .is_some_and(|(reported, expected)| {
            reported.origin() == expected.origin() && reported.path().starts_with("/__o/")
        })
}
