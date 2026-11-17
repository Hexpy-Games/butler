//! Hosted mode: the App owns the pages, this executor asks it to open, close
//! and hold them and exchanges per-page DevTools messages over byte channels.
use super::{
    Headless, HeadlessConfig, InstallSource, browser::Browser, downloads::PortFuture, lifecycle,
    page::Page, state::Tab,
};
use crate::browser::egress::ContentOrigin;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, PoisonError},
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// Where pages come from when an attached App owns them (signed-in profile, the user's tab list).
pub trait PageHost: Send + Sync {
    /// `page.open` | `page.close` | `page.hold`; answers the host's result object.
    /// An implementation must answer or fail every call within 25 seconds; the
    /// executor does not add its own timeout.
    fn call(&self, op: &'static str, args: Value) -> PortFuture;
}

/// Asks the App for a page: (target, session). The session is the tab id; the
/// target is the page's real CDP target id.
pub(super) async fn open_hosted(
    host: &Arc<dyn PageHost>,
    owner: &str,
    profile: &str,
    context: &str,
    internal: bool,
) -> Result<(String, String), String> {
    let args = json!({"owner":owner,"profile":profile,"context":context,"internal":internal});
    let reply = host.call("page.open", args).await;
    let reply = reply.map_err(|_| "browser_unavailable".to_owned())?;
    match (
        reply["status"].as_str(),
        reply["tab"].as_str(),
        reply["target"].as_str(),
    ) {
        (Some("ok"), Some(tab), Some(target)) if !tab.is_empty() && !target.is_empty() => {
            Ok((target.to_owned(), tab.to_owned()))
        }
        _ => Err("browser_unavailable".into()),
    }
}

/// The id of a new tab: the App's session id when hosted, a short id otherwise.
/// None when a hosted id is already a live tab.
pub(super) fn tab_id(
    browser: &Browser,
    tabs: &HashMap<String, Tab>,
    session: &str,
) -> Option<String> {
    if browser.host().is_some() {
        return (!tabs.contains_key(session)).then(|| session.to_owned());
    }
    Some(super::state::short_id('h', |id| tabs.contains_key(id)))
}

impl Headless {
    /// The backend over an App's pages: its one browser is connected from the
    /// start, and nothing is installed, launched or reaped.
    pub fn hosted(
        host: Arc<dyn PageHost>,
        incoming: mpsc::Receiver<Vec<u8>>,
        outgoing: mpsc::Sender<Vec<u8>>,
        root: PathBuf,
        content: Option<ContentOrigin>,
        shutdown: CancellationToken,
    ) -> Arc<Self> {
        let headless = Self::assemble(
            HeadlessConfig {
                root: root.clone(),
                install: InstallSource {
                    cache_root: root,
                    base_url: None,
                    cef_host: None,
                },
                content,
                enabled: true,
            },
            true,
        );
        let browser = Browser::connect(
            incoming,
            outgoing,
            host,
            content,
            headless.downloads.clone(),
            headless.history.clone(),
        );
        *headless
            .current
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(browser.clone());
        tokio::spawn(lifecycle::janitor(Arc::downgrade(&headless), browser));
        headless.stop_on(shutdown);
        headless
    }
}

impl Headless {
    /// The App reports who holds a page: while the user does, the tab is never
    /// reclaimed or expired.
    pub fn set_held(&self, tab: &str, held: bool) {
        if let Some(browser) = self.browser() {
            browser.shared.with_tab(tab, |t| {
                // The idle window restarts when the Agent gets the page back.
                if t.held && !held {
                    t.last_call = std::time::Instant::now();
                }
                t.held = held;
            });
            browser.changed.notify_waiters();
        }
    }
}

/// `tab.wait`: with the App, the user takes the tab over; otherwise the wait is already over.
pub(super) async fn wait(
    browser: &Browser,
    page: &Page,
    args: &Value,
    turn: Option<String>,
    epoch: u64,
) -> Value {
    let id = page.tab.as_str();
    let named = turn.clone();
    let dialog = page.shared.with_tab(id, |t| {
        t.waiting_turn = turn;
        t.waiting = t.dialog.is_some();
        t.dialog.is_some()
    });
    if let (Some(false), Some(host)) = (dialog, browser.host()) {
        // The user takes the tab: it is neither reclaimed nor expired, from before
        // the hold is asked for.
        page.shared.with_tab(id, |t| t.held = true);
        let hold =
            json!({"tab":id,"holder":"user","sticky":true,"reason":args["reason"],"turn":named});
        return match host.call("page.hold", hold).await {
            Ok(_) => json!({"status":"user_control","tab":id,"epoch":epoch}),
            Err(_) => {
                page.shared.with_tab(id, |t| t.held = false);
                json!({"status":"unknown","reason":"browser_unavailable"})
            }
        };
    }
    json!({"status":"ready","tab":id,"epoch":epoch})
}

/// `tab.waiting`: the App also learns whether the tab is waited on.
pub(super) async fn waiting(
    browser: &Browser,
    page: &Page,
    args: &Value,
    turn: Option<String>,
) -> Value {
    let id = page.tab.as_str();
    let named = turn.clone();
    let waiting = page
        .shared
        .with_tab(id, |t| {
            t.waiting_turn = turn;
            t.waiting = t.dialog.is_some() || args["value"] == true;
            t.waiting
        })
        .unwrap_or(false);
    if let Some(host) = browser.host() {
        // A failed hold is ignored on purpose: the tab snapshot is the source of truth.
        let _ = host
            .call(
                "page.hold",
                json!({"tab":id,"waiting":waiting,"turn":named}),
            )
            .await;
    }
    json!({"status":"ok"})
}
