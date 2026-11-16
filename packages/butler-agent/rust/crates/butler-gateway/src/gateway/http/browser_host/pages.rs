//! The page host: the native app owns the pages and relays raw per-page CDP,
//! and the Agent's own executor runs the tool-level ops here.
use super::{HttpState, PendingCall, relay};
use butler_runtime::browser::{ContentOrigin, Headless, PageHost, PortFuture};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock, PoisonError, Weak},
    time::Duration,
};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

/// Frames and messages queued each way before the sender waits.
const QUEUE: usize = 256;

/// Where each CDP session routes: the app's pages, and the sessions under them.
#[derive(Default)]
pub(super) struct Routes {
    /// Top-level pages by tab id (their CDP session id) → the page's target id.
    tabs: Mutex<HashMap<String, String>>,
    children: Mutex<HashMap<String, String>>,
}
impl Routes {
    pub(super) fn has_tab(&self, tab: &str) -> bool {
        lock(&self.tabs).contains_key(tab)
    }
    /// Records a page; one already known keeps its entry.
    pub(super) fn add_tab(&self, tab: &str, target: &str) {
        lock(&self.tabs)
            .entry(tab.to_owned())
            .or_insert_with(|| target.to_owned());
    }
    pub(super) fn remove_target(&self, target: &str) {
        let tab = lock(&self.tabs)
            .iter()
            .find_map(|(tab, id)| (id == target).then(|| tab.clone()));
        if let Some(tab) = tab {
            self.remove_tab(&tab);
        }
    }
    pub(super) fn remove_tab(&self, tab: &str) {
        lock(&self.tabs).remove(tab);
        lock(&self.children).retain(|_, owner| owner != tab);
    }
    pub(super) fn child_tab(&self, session: &str) -> Option<String> {
        lock(&self.children).get(session).cloned()
    }
    pub(super) fn add_child(&self, session: &str, tab: &str) {
        lock(&self.children).insert(session.to_owned(), tab.to_owned());
    }
    /// Forgets a child session, only when it belongs to `tab`.
    pub(super) fn remove_child(&self, session: &str, tab: &str) {
        let mut children = lock(&self.children);
        if children.get(session).is_some_and(|owner| owner == tab) {
            children.remove(session);
        }
    }
}
fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The link to the attached page host; dropping it ends the executor's channels.
pub(super) struct Link {
    pub(super) executor: Arc<Headless>,
    host: mpsc::Sender<Vec<u8>>,
    routes: Arc<Routes>,
    runtime: tokio::runtime::Handle,
    shutdown: CancellationToken,
    /// The attach this link serves; set once the host is admitted.
    generation: Arc<OnceLock<u64>>,
}
impl Drop for Link {
    fn drop(&mut self) {
        self.shutdown.cancel();
    }
}

impl Link {
    /// A link with its executor (built off the hub lock: it reads files), and
    /// the relay frames for the app. It serves nothing until [`Link::bind`].
    pub(super) fn new(
        state: &Arc<HttpState>,
        root: std::path::PathBuf,
    ) -> (Arc<Self>, mpsc::Receiver<Value>) {
        let generation = Arc::new(OnceLock::new());
        let (host, incoming) = mpsc::channel::<Vec<u8>>(QUEUE);
        let (outgoing, from_executor) = mpsc::channel::<Vec<u8>>(QUEUE);
        let (relay_tx, relay_rx) = mpsc::channel(QUEUE);
        let routes = Arc::new(Routes::default());
        let shutdown = CancellationToken::new();
        let port = Arc::new(Port {
            state: Arc::downgrade(state),
            routes: routes.clone(),
            generation: generation.clone(),
        });
        let content = Some(ContentOrigin(super::super::content::port(state)));
        let executor = Headless::hosted(port, incoming, outgoing, root, content, shutdown.clone());
        tokio::spawn(relay::run_down(relay::Pump {
            from_executor,
            to_executor: host.clone(),
            to_app: relay_tx,
            routes: routes.clone(),
            state: Arc::downgrade(state),
            generation: generation.clone(),
            shutdown: shutdown.clone(),
        }));
        let link = Arc::new(Self {
            executor,
            host,
            routes,
            runtime: tokio::runtime::Handle::current(),
            shutdown,
            generation,
        });
        (link, relay_rx)
    }

    /// Ties the link to the attach it was admitted for.
    pub(super) fn bind(&self, generation: u64) {
        let _ = self.generation.set(generation);
    }

    /// Runs `frame` on the executor; its value answers the pending call `id`.
    pub(super) fn serve(&self, state: Weak<HttpState>, id: String, frame: Value) {
        let executor = self.executor.clone();
        self.runtime.spawn(async move {
            let value = executor.execute(frame).await;
            let Some(state) = state.upgrade() else { return };
            let Ok(mut hub) = state.browser.0.lock() else {
                return;
            };
            if let Some(reply) = hub.pending.remove(&id) {
                reply.deliver(&hub, value);
            }
        });
    }

    /// Runs `frame` on the executor and drops its answer.
    pub(super) fn run(&self, frame: Value) {
        let executor = self.executor.clone();
        self.runtime.spawn(async move {
            executor.execute(frame).await;
        });
    }

    /// Tells the executor who holds one of its pages (the app's own are ignored).
    pub(super) fn hold(&self, tab: &str, user: bool) {
        if self.routes.has_tab(tab) {
            self.executor.set_held(tab, user);
        }
    }

    /// Closes a tab whose page fell outside policy.
    pub(super) fn revoke(&self, session: &str, tab: &str) {
        let executor = self.executor.clone();
        let (session, tab) = (session.to_owned(), tab.to_owned());
        self.runtime
            .spawn(async move { executor.revoke(&session, &tab).await });
    }

    /// Closes every tab of an archived or deleted conversation.
    pub(super) fn close_owner(&self, session: &str) {
        let executor = self.executor.clone();
        let session = session.to_owned();
        self.runtime
            .spawn(async move { executor.close_owner(&session).await });
    }

    /// Pushes the app's CDP messages to the executor, in order.
    pub(super) async fn push(&self, entries: &[Value]) {
        for entry in entries {
            if let Some(message) = relay::up(&self.routes, entry) {
                let mut bytes = message.to_string().into_bytes();
                bytes.push(0);
                if self.host.send(bytes).await.is_err() {
                    return;
                }
            }
        }
    }
}

/// Builds a link on a blocking thread: the executor reads files as it starts.
pub(super) async fn open(
    state: &Arc<HttpState>,
) -> Result<(Arc<Link>, mpsc::Receiver<Value>), super::HttpError> {
    let root = state
        .hosted_root
        .clone()
        .ok_or_else(|| super::error(503, "browser_unavailable"))?;
    let state = state.clone();
    tokio::task::spawn_blocking(move || Link::new(&state, root))
        .await
        .map_err(|_| super::HttpError::Internal)
}

/// The executor's way to ask the app for a page.
struct Port {
    state: Weak<HttpState>,
    routes: Arc<Routes>,
    generation: Arc<OnceLock<u64>>,
}
impl PageHost for Port {
    fn call(&self, op: &'static str, args: Value) -> PortFuture {
        let (state, routes, generation) = (
            self.state.clone(),
            self.routes.clone(),
            self.generation.clone(),
        );
        Box::pin(async move {
            let unavailable = || "browser_unavailable".to_owned();
            let state = state.upgrade().ok_or_else(unavailable)?;
            let value = exchange(&state, &generation, op, &args).await?;
            match op {
                "page.close" => routes.remove_tab(args["tab"].as_str().unwrap_or("")),
                "page.open" => {
                    let (tab, target) = (value["tab"].as_str(), value["target"].as_str());
                    let (Some(tab), Some(target)) = (
                        tab.filter(|t| !t.is_empty()),
                        target.filter(|t| !t.is_empty()),
                    ) else {
                        // A page that cannot be tracked is closed, never left open.
                        if let Some(tab) = tab {
                            let _ =
                                exchange(&state, &generation, "page.close", &json!({"tab":tab}))
                                    .await;
                        }
                        return Err(unavailable());
                    };
                    routes.add_tab(tab, target);
                }
                _ => {}
            }
            Ok(value)
        })
    }
}

/// One call to the page host of this port's own attach: its answer, or why not.
async fn exchange(
    state: &Arc<HttpState>,
    generation: &OnceLock<u64>,
    op: &'static str,
    args: &Value,
) -> Result<Value, String> {
    let unavailable = || "browser_unavailable".to_owned();
    let secs = if op == "page.open" { 20 } else { 5 };
    let id = uuid::Uuid::new_v4().to_string();
    let (sender, receiver) = oneshot::channel();
    {
        let mut hub = state.browser.0.lock().map_err(|_| unavailable())?;
        // A dead link never reaches a newer host.
        if generation.get() != Some(&hub.generation) || hub.pages.is_none() {
            return Err(unavailable());
        }
        let frame = json!({"id":id,"op":op,"args":args,"deadline_ms":secs * 1000});
        let host = hub.host.as_ref().ok_or_else(unavailable)?;
        host.try_send(frame).map_err(|_| unavailable())?;
        hub.pending.insert(id.clone(), sender.into());
    }
    let _pending = PendingCall {
        state: state.clone(),
        id,
    };
    let reply = tokio::time::timeout(Duration::from_secs(secs), receiver).await;
    let value = reply
        .map_err(|_| unavailable())?
        .map_err(|_| unavailable())?;
    if value["status"] != "ok" {
        return Err(value["reason"]
            .as_str()
            .map_or_else(unavailable, str::to_owned));
    }
    Ok(value)
}

/// The page host does not fill sign-ins, cards or autofill yet: these ops are
/// refused, as the hosted executor refuses them, before any secret is read.
pub(super) fn refusal(state: &HttpState, op: &str) -> Option<Value> {
    let reason = match op {
        "signin.fill" => "signed_in_unavailable",
        "pay.inspect" | "pay.fill" | "autofill.fill" => "vault_needs_app",
        _ => return None,
    };
    let paged = state.browser.0.lock().is_ok_and(|hub| hub.pages.is_some());
    paged.then(|| json!({"status":"refused","reason":reason}))
}

/// `POST /internal/browser-host/cdp`: messages from the app's pages.
pub(super) async fn cdp(
    state: Arc<HttpState>,
    body: Value,
) -> Result<axum::response::Response, super::HttpError> {
    let link = state
        .browser
        .0
        .lock()
        .map_err(|_| super::HttpError::Internal)?
        .pages
        .clone()
        .ok_or_else(|| super::error(409, "no_page_host"))?;
    let entries = body["messages"]
        .as_array()
        .ok_or_else(|| super::error(400, "invalid_request"))?;
    link.push(entries).await;
    super::super::json(axum::http::StatusCode::OK, json!({"ok":true}))
}

/// One SSE frame for the host: a control call, or a relayed CDP message.
pub(super) fn sse(
    name: &str,
    frame: &Value,
) -> Result<axum::response::sse::Event, std::convert::Infallible> {
    Ok(axum::response::sse::Event::default()
        .event(name)
        .data(frame.to_string()))
}

/// The page host's next relay frame; never ready for any other host.
pub(super) async fn next_relay(relay: &mut Option<mpsc::Receiver<Value>>) -> Option<Value> {
    match relay {
        Some(relay) => relay.recv().await,
        None => std::future::pending().await,
    }
}
