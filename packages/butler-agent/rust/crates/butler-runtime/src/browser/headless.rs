//! Butler's own headless browser: the tool backend when no App is attached.
//!
//! It executes the same tool-level protocol as the App's Electron executor
//! (`tab.open`, `tab.observe`, `tab.act`, ...) with the same page scripts and
//! result shapes, over the DevTools pipe of a pinned Chrome for Testing
//! headless shell (see [`install`]). Tabs are signed-out only: each
//! conversation gets an in-memory browser context, nothing is signed in.
//! Every destination passes the egress guard ([`super::egress`]).
//!
//! One process tree serves every conversation; it starts on the first
//! `tab.open`, an idle agent tab closes 10 minutes after its last call, and
//! the tree is ended 60 seconds after its last tab closed, taking its
//! throwaway profile directory with it.
mod act;
mod browser;
mod capture;
mod cdp;
mod check;
mod dialogs;
mod events;
mod frames;
mod hidden;
mod imaging;
mod input;
pub mod install;
mod js;
mod layout;
mod lifecycle;
mod names;
mod observe;
mod page;
mod progress;
mod render;
mod scripts;
mod settle;
mod state;
mod steps;
mod targets;
mod validate;

use super::egress::{ContentOrigin, guard_url};
use browser::Browser;
pub use install::InstallSource;
use install::{Installer, Progress};
pub use render::{Rendered, reader};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex, PoisonError,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

const INSTALL_WAIT: Duration = Duration::from_secs(15);

pub struct HeadlessConfig {
    /// Holds the throwaway profile and the browser log.
    pub root: PathBuf,
    pub install: InstallSource,
    /// Butler's output origin, the only loopback destination.
    pub content: Option<ContentOrigin>,
    /// Settings → Security; changeable while running.
    pub enabled: bool,
}

pub struct Headless {
    config: HeadlessConfig,
    installer: Arc<Installer>,
    current: Mutex<Option<Arc<Browser>>>,
    starting: tokio::sync::Mutex<()>,
    in_flight: AtomicUsize,
    enabled: std::sync::atomic::AtomicBool,
    reports: check::SharedReports,
}

fn refused(reason: &str) -> Value {
    json!({"status":"refused","reason":reason})
}

fn valid_session(session: &str) -> bool {
    !session.is_empty()
        && session.len() <= 128
        && session
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

impl Headless {
    /// The backend; nothing runs or downloads until the first `tab.open`.
    pub fn new(config: HeadlessConfig, shutdown: CancellationToken) -> Arc<Self> {
        let headless = Arc::new(Self {
            installer: Installer::new(config.install.clone()),
            enabled: std::sync::atomic::AtomicBool::new(config.enabled),
            reports: check::SharedReports::default(),
            config,
            current: Mutex::new(None),
            starting: tokio::sync::Mutex::new(()),
            in_flight: AtomicUsize::new(0),
        });
        render::register(&headless);
        let weak = Arc::downgrade(&headless);
        tokio::spawn(async move {
            shutdown.cancelled().await;
            if let Some(headless) = weak.upgrade() {
                headless.shutdown().await;
            }
        });
        headless
    }

    /// Whether new work may start here (Settings → Security).
    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    /// Turns the backend on or off; off ends the browser and its tabs now.
    pub async fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::SeqCst);
        if !enabled {
            self.shutdown().await;
        }
    }

    fn browser(&self) -> Option<Arc<Browser>> {
        self.current
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
            .filter(|b| !b.alive.is_cancelled())
    }

    /// The tab's snapshot when this backend holds it, whoever owns it.
    pub fn tab(&self, id: &str) -> Option<Value> {
        let browser = self.browser()?;
        let state = browser.shared.lock();
        state
            .tabs
            .get(id)
            .filter(|t| t.admitted)
            .map(state::Tab::snapshot)
    }

    /// Whether any headless tab is open (its calls stay here until it closes).
    pub fn has_tabs(&self) -> bool {
        self.browser()
            .is_some_and(|b| !b.shared.lock().tabs.is_empty())
    }

    /// This conversation's headless tab ids.
    pub fn owned(&self, session: &str) -> Vec<String> {
        let owner = format!("conversation:{session}");
        let Some(browser) = self.browser() else {
            return Vec::new();
        };
        let mut ids: Vec<String> = browser
            .shared
            .lock()
            .tabs
            .values()
            .filter(|t| t.owner == owner && t.admitted)
            .map(|t| t.id.clone())
            .collect();
        ids.sort();
        ids
    }

    /// Runs one tool-level call, exactly as the App executor answers it.
    pub async fn execute(self: &Arc<Self>, frame: Value) -> Value {
        self.in_flight.fetch_add(1, Ordering::SeqCst);
        let op = frame["op"].as_str().unwrap_or("").to_owned();
        let session = frame["session"].as_str().unwrap_or("").to_owned();
        let mut result = if valid_session(&session) {
            self.call(&op, &session, &frame).await
        } else {
            refused("invalid_session")
        };
        let count = if op == "tab.act" {
            frame["args"]["steps"].as_array().map_or(0, Vec::len)
        } else {
            0
        };
        if (1..=10).contains(&count)
            && !result["steps"].is_array()
            && result["status"] != "dialog_pending"
        {
            let status = if result["status"] == "unknown" {
                "unknown"
            } else {
                "not_dispatched"
            };
            let reason = result
                .get("reason")
                .cloned()
                .unwrap_or_else(|| json!("browser_refused"));
            result["steps"] = (0..count)
                .map(|index| json!({"index":index,"status":status,"reason":reason}))
                .collect();
            if status == "unknown" {
                result["observe_required"] = json!(true);
            }
        }
        self.drain(&op, &session, &mut result);
        self.in_flight.fetch_sub(1, Ordering::SeqCst);
        result
    }

    fn drain(&self, op: &str, session: &str, result: &mut Value) {
        if matches!(
            op,
            "tab.prepare" | "tab.waiting" | "tab.cancel" | "owner.closed"
        ) || result["status"] == "dialog_pending"
        {
            return;
        }
        let Some(browser) = self.browser() else {
            return;
        };
        let events = browser
            .shared
            .lock()
            .events
            .remove(&format!("conversation:{session}"));
        if let Some(events) = events.filter(|e| !e.is_empty()) {
            result["events"] = json!(events);
        }
    }

    async fn call(self: &Arc<Self>, op: &str, session: &str, frame: &Value) -> Value {
        let args = &frame["args"];
        match op {
            "tabs.list" => {
                let owner = format!("conversation:{session}");
                let tabs = self
                    .browser()
                    .map(|b| {
                        b.shared
                            .lock()
                            .snapshots()
                            .into_iter()
                            .filter(|t| t["owner"] == owner.as_str())
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                json!({"tabs":tabs})
            }
            "owner.closed" => {
                self.close_owner(session).await;
                json!({"status":"ok"})
            }
            "tab.open" => {
                self.open(
                    session,
                    args,
                    frame["deadline_ms"].as_u64().unwrap_or(20_000),
                )
                .await
            }
            _ => self.tab_call(op, session, frame).await,
        }
    }

    async fn ready(self: &Arc<Self>) -> Result<Arc<Browser>, Value> {
        if let Some(browser) = self.browser() {
            return Ok(browser);
        }
        let _start = self.starting.lock().await;
        if let Some(browser) = self.browser() {
            return Ok(browser);
        }
        let executable = match self.installer.executable_within(INSTALL_WAIT).await {
            Progress::Ready(path) => path,
            Progress::Running { received, total } => {
                return Err(
                    json!({"status":"unavailable","reason":"browser_installing","progress":{"received":received,"total":total},
                    "recovery":"The browser is being installed for its first use. Retry browser_open shortly; nothing was opened."}),
                );
            }
            Progress::Failed(reason) => {
                return Err(json!({"status":"unavailable","reason":reason}));
            }
        };
        let browser = Browser::launch(&executable, &self.config.root, self.config.content)
            .await
            .map_err(|reason| json!({"status":"unavailable","reason":reason}))?;
        *self.current.lock().unwrap_or_else(PoisonError::into_inner) = Some(browser.clone());
        tokio::spawn(lifecycle::janitor(Arc::downgrade(self), browser.clone()));
        Ok(browser)
    }

    async fn open(self: &Arc<Self>, session: &str, args: &Value, deadline_ms: u64) -> Value {
        if args["profile"] == "signed_in" || args["signed_in"] == true {
            return refused("signed_in_unavailable");
        }
        if !self.enabled() {
            return json!({"status":"unavailable","reason":"no_browser"});
        }
        let started = Instant::now();
        let url = args["url"].as_str().unwrap_or("").to_owned();
        if !guard_url(&url, self.config.content).await {
            return refused("navigation_denied");
        }
        let browser = match self.ready().await {
            Ok(browser) => browser,
            Err(unavailable) => return unavailable,
        };
        let owner = format!("conversation:{session}");
        {
            let state = browser.shared.lock();
            if state.tabs.len() >= 6
                || state.tabs.values().filter(|t| t.owner == owner).count() >= 3
            {
                return refused("tab_budget_exhausted");
            }
            let driving: std::collections::HashSet<&String> =
                state.tabs.values().map(|t| &t.owner).collect();
            if driving.len() >= 2 && !driving.contains(&owner) {
                return json!({"status":"not_dispatched","reason":"browser_busy"});
            }
        }
        let remaining = Duration::from_millis(deadline_ms.saturating_sub(500))
            .saturating_sub(started.elapsed());
        match lifecycle::open_tab(&browser, &owner, &url, args, remaining).await {
            Ok(value) => value,
            Err(reason) => json!({"status":"unknown","reason":reason}),
        }
    }

    async fn tab_call(self: &Arc<Self>, op: &str, session: &str, frame: &Value) -> Value {
        let id = frame["tab"].as_str().unwrap_or("");
        let args = &frame["args"];
        let Some(browser) = self.browser() else {
            return refused("not_your_tab");
        };
        let Some(page) = browser.page(id) else {
            return refused("not_your_tab");
        };
        let owner = format!("conversation:{session}");
        let facts = page
            .shared
            .with_tab(id, |t| (t.owner == owner, t.dialog.is_some(), t.epoch));
        let Some((true, dialog, epoch)) = facts else {
            return refused("not_your_tab");
        };
        let turn = frame["turn_id"].as_str().map(str::to_owned);
        match op {
            "tab.selection" => {
                return json!({"status":"ok","tab":id,"untrusted_content":{"kind":"web_page_data","elements":[]}});
            }
            "tab.cancel" => {
                page.shared.with_tab(id, |t| {
                    if t.call_id.as_ref() == args["call_id"].as_str().map(str::to_owned).as_ref() {
                        t.cancelled = true;
                    }
                });
                return json!({"status":"ok"});
            }
            "tab.wait" => {
                page.shared.with_tab(id, |t| {
                    t.waiting_turn = turn;
                    t.waiting = t.dialog.is_some();
                });
                return json!({"status":"ready","tab":id,"epoch":epoch});
            }
            "tab.waiting" => {
                page.shared.with_tab(id, |t| {
                    t.waiting_turn = turn;
                    t.waiting = t.dialog.is_some() || args["value"] == true;
                });
                return json!({"status":"ok"});
            }
            "tab.close" => return dialogs::request_close(&browser, &page).await,
            // No signed-in headless: nothing here can fill or grant a sign-in.
            _ if op.starts_with("signin.") => return refused("signed_in_unavailable"),
            "tab.dialog" => return dialogs::answer(&browser, &page, args).await,
            _ => {}
        }
        if dialog {
            return page
                .shared
                .with_tab(id, |t| t.pending_dialog())
                .unwrap_or_else(|| refused("not_your_tab"));
        }
        let crashed = page
            .shared
            .with_tab(id, |t| {
                t.last_call = Instant::now();
                t.crashed
            })
            .unwrap_or(true);
        browser.changed.notify_waiters();
        if crashed {
            return json!({"status":"unknown","reason":"tab_crashed"});
        }
        let outcome = match op {
            "tab.observe" => observe::observe(&page, args).await,
            "tab.screenshot" => capture::screenshot(&page, args).await,
            "tab.zoom" => capture::zoom(&page, args).await,
            "tab.prepare" => act::prepare(&page, args).await,
            "tab.act" => return act_call(&page, args, frame).await,
            _ => return refused("unsupported_op"),
        };
        outcome.unwrap_or_else(|error| failed(&browser, &error))
    }

    /// Closes every tab of an archived or deleted conversation.
    pub async fn close_owner(&self, session: &str) {
        let Some(browser) = self.browser() else {
            return;
        };
        let owner = format!("conversation:{session}");
        let ids: Vec<String> = browser
            .shared
            .lock()
            .tabs
            .values()
            .filter(|t| t.owner == owner)
            .map(|t| t.id.clone())
            .collect();
        for id in ids {
            targets::close(&browser, &id).await;
        }
        browser.shared.lock().events.remove(&owner);
    }

    /// A tab whose reported page fell outside policy: closed at once.
    pub async fn revoke(&self, session: &str, tab: &str) {
        let Some(browser) = self.browser() else {
            return;
        };
        let owned = browser
            .shared
            .with_tab(tab, |t| t.owner == format!("conversation:{session}"))
            .unwrap_or(false);
        if owned {
            targets::close(&browser, tab).await;
        }
    }

    /// Drops `browser` as the current one (it is being stopped).
    fn forget(&self, browser: &Arc<Browser>) {
        let mut current = self.current.lock().unwrap_or_else(PoisonError::into_inner);
        if current.as_ref().is_some_and(|c| Arc::ptr_eq(c, browser)) {
            *current = None;
        }
    }

    /// Ends the browser process tree now (service shutdown).
    pub async fn shutdown(&self) {
        let browser = self
            .current
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(browser) = browser {
            browser.stop().await;
        }
    }
}

fn failed(browser: &Browser, error: &str) -> Value {
    if browser.alive.is_cancelled() || error == "browser_closed" {
        return json!({"status":"unknown","reason":"browser_host_lost"});
    }
    eprintln!("WARN [browser] headless call failed: {error}");
    json!({"status":"unknown","reason":"executor_error"})
}

async fn act_call(page: &page::Page, args: &Value, frame: &Value) -> Value {
    let owner = page
        .shared
        .with_tab(&page.tab, |t| t.owner.clone())
        .unwrap_or_default();
    let busy = {
        let state = page.shared.lock();
        let owners: std::collections::HashSet<&String> = state
            .tabs
            .values()
            .filter(|t| t.busy)
            .map(|t| &t.owner)
            .collect();
        (owners.len() >= 2 && !owners.contains(&owner))
            || state.tabs.get(&page.tab).is_some_and(|t| t.busy)
    };
    if busy {
        return json!({"status":"not_dispatched","reason":"browser_busy"});
    }
    page.shared.with_tab(&page.tab, |t| {
        t.busy = true;
        t.cancelled = false;
        t.call_id = frame["call_id"].as_str().map(str::to_owned);
    });
    let deadline = frame["deadline_ms"].as_u64().unwrap_or(30_000);
    let result = act::act(page, args, deadline).await;
    page.shared.with_tab(&page.tab, |t| t.busy = false);
    result.unwrap_or_else(|_| json!({"status":"unknown","reason":"executor_error"}))
}
