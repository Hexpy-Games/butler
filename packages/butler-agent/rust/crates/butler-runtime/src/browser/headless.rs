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
mod calls;
mod capture;
mod cdp;
mod check;
mod collect;
mod collect_crop;
mod devtools;
mod dialogs;
pub mod downloads;
mod events;
mod frames;
mod hidden;
pub mod history;
mod identity;
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

use super::egress::{ContentOrigin, guard_preview_url, guard_url};
use browser::Browser;
pub use install::InstallSource;
use install::Installer;
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
    closing: tokio::sync::Mutex<()>,
    in_flight: AtomicUsize,
    enabled: std::sync::atomic::AtomicBool,
    reports: check::SharedReports,
    downloads: Arc<downloads::Downloads>,
    history: Arc<history::History>,
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
            downloads: downloads::Downloads::new(&config.root),
            history: Arc::default(),
            config,
            current: Mutex::new(None),
            starting: tokio::sync::Mutex::new(()),
            closing: tokio::sync::Mutex::new(()),
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

    /// Hook for private browsing; it suppresses both commits and metadata.
    pub fn set_history_private(&self, private: bool) {
        self.history.set_private(private);
    }

    /// Sends visible conversation visits to the App storage owner.
    pub fn set_history_port(&self, port: Arc<dyn history::HistoryPort>) {
        self.history.set_port(port);
    }

    /// Where conversation downloads land and become outputs (the gateway).
    pub fn set_download_port(&self, port: Arc<dyn downloads::DownloadPort>) {
        self.downloads.set_port(port);
    }

    /// Whether operator configuration permits new work on this backend.
    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
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
        let _in_flight = lifecycle::InFlight::enter(&self.in_flight);
        let op = frame["op"].as_str().unwrap_or("").to_owned();
        let session = frame["session"].as_str().unwrap_or("").to_owned();
        let turn = frame["turn_id"].as_str();
        self.drive(&session, &frame["tab"], turn);
        let mut result = if valid_session(&session) {
            self.call(&op, &session, &frame).await
        } else {
            refused("invalid_session")
        };
        if op == "tab.open" {
            self.drive(&session, &result["tab"], turn);
        }
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
        self.drain(&op, &session, turn, &mut result);
        result
    }

    /// Records the running turn that drives `tab`, so its events reach it.
    fn drive(&self, session: &str, tab: &Value, turn: Option<&str>) {
        if let (Some(browser), Some(tab), Some(turn)) = (self.browser(), tab.as_str(), turn) {
            let owner = format!("conversation:{session}");
            browser.shared.with_tab(tab, |t| {
                if t.owner == owner {
                    t.turn = Some(turn.to_owned());
                }
            });
        }
    }

    fn drain(&self, op: &str, session: &str, turn: Option<&str>, result: &mut Value) {
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
            .drain(&format!("conversation:{session}"), turn);
        if !events.is_empty() {
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
                let deadline = frame["deadline_ms"].as_u64().unwrap_or(20_000);
                self.open(session, args, deadline, frame["turn_id"].as_str())
                    .await
            }
            _ => self.tab_call(op, session, frame).await,
        }
    }

    async fn open(
        self: &Arc<Self>,
        session: &str,
        args: &Value,
        deadline_ms: u64,
        turn: Option<&str>,
    ) -> Value {
        if args["profile"] == "signed_in" || args["signed_in"] == true {
            return refused("signed_in_unavailable");
        }
        if !self.enabled() {
            return json!({"status":"unavailable","reason":"no_browser"});
        }
        let started = Instant::now();
        let url = args["url"].as_str().unwrap_or("").to_owned();
        let admitted = if lifecycle::preview_of(args).is_some() {
            guard_preview_url(&url, self.config.content).await
        } else {
            guard_url(&url, self.config.content).await
        };
        if !admitted {
            return refused("navigation_denied");
        }
        let browser = match self.ready().await {
            Ok(browser) => browser,
            Err(unavailable) => return unavailable,
        };
        let owner = format!("conversation:{session}");
        // Memory bounds the open tabs; conversations share them (several
        // browse at once), and an idle tab closes to make room for a new one.
        if !targets::make_room(&browser, &[], turn).await {
            return refused("tab_budget_exhausted");
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
            // Saved cards and autofill details fill only in the App browser.
            _ if op.starts_with("pay.") || op == "autofill.fill" => {
                return refused("vault_needs_app");
            }
            "tab.dialog" => return dialogs::answer(&browser, &page, args).await,
            _ => {}
        }
        if dialog {
            return pending_dialog(&page, id);
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
            "tab.read" => render::read_tab(&page).await,
            "tab.devtools_place" | "tab.devtools" => devtools::call(&page, op, args).await,
            "tab.image_collect" => collect::collect(&page, args).await,
            "tab.screenshot" => capture::screenshot(&page, args).await,
            "tab.zoom" => capture::zoom(&page, args).await,
            "tab.prepare" => act::prepare(&page, args).await,
            "tab.act" => return calls::act_call(&page, args, frame).await,
            _ => return refused("unsupported_op"),
        };
        outcome.unwrap_or_else(|error| calls::failed(&browser, &error))
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

    /// Closes a stopped preview's tabs, as the App does on `preview.closed`.
    pub async fn close_preview(&self, session: &str, preview: &str) {
        let Some(browser) = self.browser() else {
            return;
        };
        let owner = format!("conversation:{session}");
        let ids: Vec<String> = browser
            .shared
            .lock()
            .tabs
            .values()
            .filter(|t| t.owner == owner && t.preview.as_deref() == Some(preview))
            .map(|t| t.id.clone())
            .collect();
        for id in ids {
            targets::close(&browser, &id).await;
        }
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
        let _closing = self.closing.lock().await;
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

/// The dialog a tab call waits behind.
fn pending_dialog(page: &page::Page, id: &str) -> Value {
    page.shared
        .with_tab(id, |t| t.pending_dialog())
        .unwrap_or_else(|| refused("not_your_tab"))
}
