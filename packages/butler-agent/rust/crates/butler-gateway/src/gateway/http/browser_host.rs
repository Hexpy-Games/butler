//! Main-only, ephemeral output-check transport. No event log, files or polling.
pub(super) mod agent_calls;
mod backend;
pub(super) mod downloads;
mod fill;
mod hand_back;
pub(super) mod hidden;
mod pay;
mod payment_scope;
mod previews;
pub(super) mod reader;
mod report;
mod shots;
pub(super) mod signed_in;
mod still_delivery;
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
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{mpsc, oneshot};

/// The attached host's state, the still-upload lock, a signal on changes of
/// the attached host's tabs and calls (the hidden host's reap), and the call
/// slots.
#[derive(Default)]
pub(super) struct Hub(
    Mutex<Inner>,
    tokio::sync::Mutex<()>,
    tokio::sync::Notify,
    Slots,
    pub(super) tokio::sync::Notify,
    tokio::sync::Mutex<()>,
);
/// Browser calls executing at once, sized to the machine; a call beyond them
/// waits for a slot instead of being refused, on whichever browser serves it.
pub(super) struct Slots(tokio::sync::Semaphore);
impl Default for Slots {
    fn default() -> Self {
        Self(tokio::sync::Semaphore::new(
            butler_runtime::browser::call_slots(),
        ))
    }
}
impl Slots {
    /// Waits for a slot; held until the call's answer.
    pub(super) async fn acquire(&self) -> Result<tokio::sync::SemaphorePermit<'_>, HttpError> {
        self.0.acquire().await.map_err(|_| HttpError::Internal)
    }
    /// A slot for an op that works on a page; control ops (cancel, waits,
    /// lists) never wait behind page work.
    pub(super) async fn page_work(
        &self,
        op: &str,
    ) -> Result<Option<tokio::sync::SemaphorePermit<'_>>, HttpError> {
        if usage::executes(op) {
            return self.acquire().await.map(Some);
        }
        Ok(None)
    }
}
/// Frames the host channel holds: each call in a slot sends at most three
/// (`use.started`, the call, `use.ended`), plus control frames.
fn channel_frames() -> usize {
    butler_runtime::browser::call_slots() * 3 + 16
}
#[derive(Default)]
struct Inner {
    host: Option<mpsc::Sender<Value>>,
    pending: HashMap<String, PendingReply>,
    tabs: butler_runtime::browser::TabRegistry,
    uses: HashMap<String, usage::Use>,
    turns: HashSet<(String, String)>,
    /// Session → (turn, backend) its newest turn's tabs open on.
    pins: HashMap<String, (String, backend::Backend)>,
    fills: HashMap<String, fill::Fill>,
    vault_fills: HashMap<String, pay::VaultFill>,
    /// The attached host is the hidden App host (no window, no user there).
    hidden: bool,
    /// Durable evidence still owned by this host, including queued captures.
    still_backlog: u64,
    /// The previous host is settling and exiting before another host can attach.
    retiring: bool,
    /// The App asked for the channel while the hidden host was busy.
    app_waiting: bool,
    /// Counts attaches; a stream's end clears only its own attach.
    generation: u64,
}
/// Ownership is checked while accepting a host reply, before detach can erase
/// the registry. Calls without a tab (including output checks) have no fence.
struct PendingReply {
    sender: oneshot::Sender<Value>,
    owner: Option<(String, String, String)>,
}
impl From<oneshot::Sender<Value>> for PendingReply {
    fn from(sender: oneshot::Sender<Value>) -> Self {
        Self {
            sender,
            owner: None,
        }
    }
}
impl PendingReply {
    fn agent(sender: oneshot::Sender<Value>, frame: &Value) -> Self {
        let owner = frame["tab"].as_str().map(|tab| {
            (
                frame["session"].as_str().unwrap_or("").to_owned(),
                tab.to_owned(),
                frame["op"].as_str().unwrap_or("").to_owned(),
            )
        });
        Self { sender, owner }
    }
    fn deliver(self, hub: &Inner, mut value: Value) {
        if let Some((session, tab, op)) = self.owner {
            agent_calls::recheck_owner(hub, &session, Some(&tab), &op, &mut value);
        }
        let _ = self.sender.send(value);
    }
}
impl Inner {
    /// Forgets the attached host and everything it served.
    fn detach(&mut self) {
        self.host = None;
        self.hidden = false;
        self.still_backlog = 0;
        self.app_waiting = false;
        self.generation += 1;
        self.pending.clear();
        self.tabs.clear();
        self.uses.clear();
        self.turns.clear();
        self.fills.clear();
        self.vault_fills.clear();
    }
}
struct HostStream {
    state: Arc<HttpState>,
    receiver: mpsc::Receiver<Value>,
    generation: u64,
    _subscription: Box<dyn crate::gateway::EventSubscription>,
}
impl Drop for HostStream {
    fn drop(&mut self) {
        if let Ok(mut hub) = self.state.browser.0.lock()
            && hub.generation == self.generation
        {
            hidden::detached(&self.state, &mut hub);
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
        (&Method::GET, "/internal/browser-host") => {
            let launch = hidden::launch_of(request.headers());
            attach(state, client.keys.live_streams(), launch.as_deref()).await
        }
        (&Method::POST, "/internal/browser-host/downloads") => {
            downloads::handle(state, read_json(request).await?).await
        }
        (&Method::POST, "/internal/images/calls") => {
            let frame = read_json(request).await?;
            if !matches!(
                frame["op"].as_str(),
                Some("images.resolve" | "images.store" | "images.usage")
            ) {
                return Err(error(400, "invalid_image_op"));
            }
            agent_calls::call(state, frame).await
        }
        (&Method::POST, "/internal/browser/calls") => call(state, request).await,
        (&Method::POST, "/internal/browser-host/stills") => {
            agent_calls::still(state, read_json(request).await?).await
        }
        (&Method::POST, "/internal/browser-host/visits") => {
            super::library::history::record(state, request).await
        }
        (&Method::POST, "/internal/browser-host/events") => {
            agent_calls::events(state, read_json(request).await?).await
        }
        (&Method::POST, p) if p.starts_with("/internal/browser-host/credentials/") => {
            let token = p
                .trim_start_matches("/internal/browser-host/credentials/")
                .to_owned();
            fill::credentials(state, &token, &read_json(request).await?).await
        }
        (&Method::POST, p) if p.starts_with("/internal/browser-host/vault/") => {
            let token = p
                .trim_start_matches("/internal/browser-host/vault/")
                .to_owned();
            pay::secrets(state, &token, &read_json(request).await?).await
        }
        (&Method::POST, p)
            if p.starts_with("/internal/browser-host/results/")
                || p.starts_with("/internal/browser-host/renders/")
                || p.starts_with("/internal/browser-host/images/") =>
        {
            let id = p
                .trim_start_matches("/internal/browser-host/results/")
                .trim_start_matches("/internal/browser-host/renders/")
                .trim_start_matches("/internal/browser-host/images/");
            let body = read_json(request).await?;
            let mut hub = state.browser.0.lock().map_err(|_| HttpError::Internal)?;
            let Some(reply) = hub.pending.remove(id) else {
                return Err(error(409, "browser_call_expired"));
            };
            reply.deliver(&hub, body);
            super::json(StatusCode::OK, json!({"ok":true}))
        }
        _ => Err(error(404, "not_found")),
    }
}
async fn attach(
    state: Arc<HttpState>,
    rotated: tokio_util::sync::CancellationToken,
    launch: Option<&str>,
) -> Result<Response, HttpError> {
    let (sender, receiver) = mpsc::channel(channel_frames());
    let generation = register_host(&state, sender, launch).await?;
    if launch.is_some() {
        hidden::watch(&state, generation);
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
            let _ = hand_back::resume_waits(&state, &tabs).await;
        });
    }))?;
    let shutdown = state.shutdown.clone();
    let stream = stream::unfold(
        HostStream {
            state,
            receiver,
            generation,
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
    hidden::ensure(&state, None).await;
    let attached = state
        .browser
        .0
        .lock()
        .map_err(|_| HttpError::Internal)?
        .host
        .is_some();
    if !attached && let Some(headless) = state.headless.clone().filter(|h| h.enabled()) {
        // No App: Butler's own browser checks the output, same policy and shape.
        let origin = format!("http://127.0.0.1:{}", super::content::port(&state));
        let value = headless.output_check(&args, &origin).await;
        return super::json(StatusCode::OK, checked(&value, &args));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let (sender, receiver) = oneshot::channel();
    let _slot = state.browser.3.acquire().await?;
    {
        let mut hub = state.browser.0.lock().map_err(|_| HttpError::Internal)?;
        let Some(host) = hub.host.as_ref() else {
            return super::json(
                StatusCode::OK,
                json!({"status":"unavailable","reason":"no_browser"}),
            );
        };
        host.try_send(json!({"id":id,"lease":{"id":id,"kind":"output_check","content_origin":url::Url::parse(args["url"].as_str().unwrap_or("")).map_err(|_| error(400,"invalid_request"))?.origin().ascii_serialization()},"op":"output.check","args":args,"deadline_ms":7500}))
            .map_err(|_| error(429, "browser_busy"))?;
        hub.pending.insert(id.clone(), sender.into());
    }
    let _pending = PendingCall {
        state: state.clone(),
        id: id.clone(),
    };
    let result = tokio::select! {
        () = state.shutdown.cancelled() => json!({"status":"unknown","reason":"browser_host_lost"}),
        result = tokio::time::timeout(Duration::from_secs(8), receiver) => match result {
            Ok(Ok(value)) => checked(&value, &args),
            Ok(Err(_)) => json!({"status":"unknown","reason":"browser_host_lost"}),
            Err(_) => json!({"status":"unknown","reason":"timeout"}),
        }
    };
    super::json(StatusCode::OK, result)
}

/// An executor's check result as the tool reports it, whichever browser ran it.
fn checked(value: &Value, args: &Value) -> Value {
    if value["status"] == "ok" && !allowed_result_url(value, args) {
        return json!({"status":"navigation_denied"});
    }
    let mut report = report::shape(value);
    if args["include_image"] != true
        && let Some(r) = report.as_object_mut()
    {
        r.remove("image");
    }
    if args["include_image"] == true
        && report.get("image").is_none()
        && report["status"] != "unknown"
    {
        report["status"] = json!("unknown");
        report["reason"] = json!("image_unavailable");
    }
    report
}

async fn read_json(request: Request<Body>) -> Result<Value, HttpError> {
    let path = request.uri().path();
    // Rendered pages and collected pixels: up to 8 MiB, base64 in JSON.
    let limit = if path == "/internal/images/calls" {
        70 * 1024 * 1024
    } else if path.starts_with("/internal/browser-host/renders/")
        || path.starts_with("/internal/browser-host/images/")
    {
        12 * 1024 * 1024
    } else if path.starts_with("/internal/browser-host/results/") {
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
            hidden::hand_over(&self.state, &mut hub);
        }
        self.state.browser.2.notify_waiters();
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

mod assets;

mod calls_validation;

async fn register_host(
    state: &HttpState,
    sender: mpsc::Sender<Value>,
    launch: Option<&str>,
) -> Result<u64, HttpError> {
    let _attach = state.browser.5.lock().await;
    {
        let mut hub = state.browser.0.lock().map_err(|_| HttpError::Internal)?;
        hidden::admit(state, &mut hub, launch)?;
    }
    loop {
        let changed = state.browser.2.notified();
        tokio::pin!(changed);
        changed.as_mut().enable();
        if !state
            .browser
            .0
            .lock()
            .map_err(|_| HttpError::Internal)?
            .retiring
        {
            break;
        }
        tokio::select! {
            () = changed => (),
            () = state.shutdown.cancelled() => return Err(error(503, "gateway_closing")),
        }
    }
    let generation = {
        let mut hub = state.browser.0.lock().map_err(|_| HttpError::Internal)?;
        hub.host = Some(sender);
        hub.hidden = launch.is_some();
        hub.app_waiting = false;
        hub.generation += 1;
        hub.generation
    };
    Ok(generation)
}
