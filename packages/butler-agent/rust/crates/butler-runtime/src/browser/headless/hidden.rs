//! Hidden pages: Butler's own short-lived pages that no conversation owns
//! (output checks, reader renders). Each gets a fresh in-memory context,
//! the egress proxy, no dialogs, no downloads, and a request guard of its
//! own; they never appear in a conversation's tabs.
use super::{
    browser::Browser,
    page::Page,
    state::{Tab, short_id},
    targets,
};
use crate::browser::egress::guard_url;
use serde_json::{Value, json};
use std::{collections::HashMap, sync::Arc, time::Duration};

const MAX_SHOWN: usize = 1024;

/// What a hidden page may load.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Purpose {
    /// An output check: frames only on the output origin's `/__o/` paths;
    /// subresources there, external `https` GETs, `data:` and `blob:`.
    Check { origin: String },
    /// A reader render: the navigation guard for every frame document.
    Render,
}

/// Page diagnostics a hidden page collects (errors only; totals survive).
#[derive(Default)]
pub(crate) struct Diagnostics {
    pub total: usize,
    pub shown: Vec<String>,
    pub denied: bool,
    pub root_absolute: bool,
    pub status: Option<u16>,
    urls: HashMap<String, String>,
}

/// JavaScript's `String(value).slice(0, 100)` without a split surrogate.
fn compact(value: &str) -> String {
    let units: Vec<u16> = value.encode_utf16().take(100).collect();
    String::from_utf16_lossy(&units)
        .trim_end_matches('\u{fffd}')
        .to_owned()
}

impl Diagnostics {
    fn add(&mut self, message: &str) {
        if self.shown.len() < MAX_SHOWN {
            self.shown.push(compact(message));
        }
        self.total += 1;
    }

    fn path(&self, request: &str) -> String {
        self.urls
            .get(request)
            .and_then(|u| url::Url::parse(u).ok())
            .map_or_else(String::new, |u| u.path().to_owned())
    }

    /// Applies one page event (console errors, exceptions, failed requests).
    pub(crate) fn event(&mut self, method: &str, params: &Value, main_frame: &str) {
        match method {
            "Network.requestWillBeSent" => {
                let id = params["requestId"].as_str().unwrap_or("").to_owned();
                self.urls.insert(
                    id,
                    params["request"]["url"].as_str().unwrap_or("").to_owned(),
                );
            }
            "Network.responseReceived" => {
                let status = params["response"]["status"].as_u64().unwrap_or(0);
                if params["type"] == "Document" && params["frameId"] == main_frame {
                    self.status = u16::try_from(status).ok();
                }
                if status >= 400 {
                    let path = self.path(params["requestId"].as_str().unwrap_or(""));
                    self.add(&format!("request: HTTP {status} {path}"));
                }
            }
            "Network.loadingFailed" => {
                let path = self.path(params["requestId"].as_str().unwrap_or(""));
                self.add(&format!(
                    "request: {} {path}",
                    params["errorText"].as_str().unwrap_or("")
                ));
            }
            "Runtime.consoleAPICalled" if params["type"] == "error" => {
                let first = &params["args"][0];
                let text = first["value"]
                    .as_str()
                    .or_else(|| first["description"].as_str())
                    .unwrap_or("");
                self.add(text);
            }
            "Runtime.exceptionThrown" => {
                let details = &params["exceptionDetails"];
                let text = details["exception"]["description"]
                    .as_str()
                    .or_else(|| details["text"].as_str())
                    .unwrap_or("");
                self.add(text.lines().next().unwrap_or(""));
            }
            _ => {}
        }
    }
}

/// A hidden page while it lives; `close` ends it and its context.
pub(crate) struct HiddenPage {
    pub browser: Arc<Browser>,
    pub page: Page,
    context: String,
}

impl HiddenPage {
    pub(crate) async fn open(browser: &Arc<Browser>, purpose: Purpose) -> Result<Self, String> {
        let created = browser
            .cdp
            .send("Target.createBrowserContext", json!({"disposeOnDetach":true,"proxyServer":browser.proxy_url,"proxyBypassList":"<-loopback>"}), None)
            .await?;
        let context = created["browserContextId"]
            .as_str()
            .unwrap_or("")
            .to_owned();
        let _ = browser
            .cdp
            .send(
                "Browser.setDownloadBehavior",
                json!({"behavior":"deny","browserContextId":context}),
                None,
            )
            .await;
        let (target, session) = targets::create(&browser.cdp, &browser.shared, &context).await?;
        let id = {
            let mut state = browser.shared.lock();
            let id = short_id('x', |id| state.tabs.contains_key(id));
            let mut tab = Tab::new(
                id.clone(),
                format!("hidden:{id}"),
                target.clone(),
                session.clone(),
            );
            tab.admitted = false;
            tab.context = context.clone();
            tab.hidden = Some(purpose.clone());
            tab.diagnostics = Some(Diagnostics::default());
            state.tabs.insert(id.clone(), tab);
            state.sessions.insert(session.clone(), id.clone());
            id
        };
        let page = Page {
            cdp: browser.cdp.clone(),
            shared: browser.shared.clone(),
            tab: id,
            session: session.clone(),
            target,
        };
        let patterns = match purpose {
            Purpose::Check { .. } => json!([{"urlPattern":"*","requestStage":"Request"}]),
            Purpose::Render => json!([{"resourceType":"Document","requestStage":"Request"}]),
        };
        let hidden = Self {
            browser: browser.clone(),
            page,
            context,
        };
        for (method, params) in [
            ("Page.enable", json!({})),
            ("Runtime.enable", json!({})),
            ("Network.enable", json!({})),
            ("Fetch.enable", json!({"patterns":patterns})),
            (
                "Emulation.setDeviceMetricsOverride",
                json!({"width":targets::VIEWPORT.0,"height":targets::VIEWPORT.1,"deviceScaleFactor":1,"mobile":false}),
            ),
            ("Runtime.runIfWaitingForDebugger", json!({})),
        ] {
            if let Err(error) = hidden.page.send(method, params).await {
                hidden.close().await;
                return Err(error);
            }
        }
        Ok(hidden)
    }

    /// Navigates and waits for the load event, at most `budget`.
    pub(crate) async fn navigate(&self, url: &str, budget: Duration) -> Result<(), String> {
        let mut loads = self
            .page
            .shared
            .with_tab(&self.page.tab, |t| t.loads.subscribe())
            .ok_or("tab_closed")?;
        let navigated = self.page.send("Page.navigate", json!({"url":url})).await?;
        if navigated["errorText"]
            .as_str()
            .is_some_and(|e| !e.is_empty())
        {
            return Err("navigation_failed".into());
        }
        tokio::time::timeout(budget, loads.changed())
            .await
            .map_err(|_| "timeout".to_owned())?
            .map_err(|_| "tab_closed".to_owned())
    }

    pub(crate) fn diagnostics<T>(&self, f: impl FnOnce(&Diagnostics) -> T) -> Option<T> {
        self.page
            .shared
            .with_tab(&self.page.tab, |t| t.diagnostics.as_ref().map(f))
            .flatten()
    }

    pub(crate) async fn close(self) {
        let removed = self.browser.shared.lock().remove(&self.page.tab);
        if let Some(tab) = removed {
            let _ = self
                .browser
                .cdp
                .send("Target.closeTarget", json!({"targetId":tab.target}), None)
                .await;
        }
        let _ = self
            .browser
            .cdp
            .send(
                "Target.disposeBrowserContext",
                json!({"browserContextId":self.context}),
                None,
            )
            .await;
        self.browser.changed.notify_waiters();
    }
}

fn check_allowed(url: &str, origin: &str) -> bool {
    url::Url::parse(url)
        .is_ok_and(|u| u.origin().ascii_serialization() == origin && u.path().starts_with("/__o/"))
}

/// A hidden page's request decision: continue (true) or fail (false).
pub(crate) async fn admit(browser: &Browser, tab: &str, purpose: &Purpose, params: &Value) -> bool {
    let url = params["request"]["url"].as_str().unwrap_or("");
    let frame = params["resourceType"] == "Document";
    let allowed = match purpose {
        Purpose::Check { origin } => {
            let ok = if frame {
                check_allowed(url, origin)
            } else {
                check_allowed(url, origin)
                    || url.starts_with("https:") && params["request"]["method"] == "GET"
                    || url.starts_with("data:")
                    || url.starts_with("blob:")
            };
            let root =
                !frame && url.starts_with(&format!("{origin}/")) && !check_allowed(url, origin);
            browser.shared.with_tab(tab, |t| {
                if let Some(d) = t.diagnostics.as_mut() {
                    d.denied |= frame && !ok;
                    d.root_absolute |= root;
                }
            });
            ok
        }
        Purpose::Render => guard_url(url, browser.content).await,
    };
    if !allowed && matches!(purpose, Purpose::Render) && frame {
        browser.shared.with_tab(tab, |t| {
            if let Some(d) = t.diagnostics.as_mut() {
                d.denied = true;
            }
        });
    }
    allowed
}

/// Answers a paused request of a hidden page; false when `session` is no hidden page.
pub(crate) async fn answer(browser: &Browser, session: &str, params: &Value) -> bool {
    let request = params["requestId"].clone();
    let hidden = {
        let state = browser.shared.lock();
        state.tab_of_session(session).and_then(|id| {
            state
                .tabs
                .get(&id)
                .and_then(|t| t.hidden.clone().map(|p| (id, p)))
        })
    };
    let Some((tab, purpose)) = hidden else {
        return false;
    };
    let method = if admit(browser, &tab, &purpose, params).await {
        ("Fetch.continueRequest", json!({"requestId":request}))
    } else {
        (
            "Fetch.failRequest",
            json!({"requestId":request,"errorReason":"BlockedByClient"}),
        )
    };
    let _ = browser.cdp.send(method.0, method.1, Some(session)).await;
    true
}
