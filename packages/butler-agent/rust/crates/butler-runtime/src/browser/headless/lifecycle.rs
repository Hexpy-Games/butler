//! Tab creation and the idle lifecycle of the headless browser process.
use super::{Headless, INSTALL_WAIT, browser::Browser, host, install::Progress, state, targets};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc, PoisonError,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

const TAB_IDLE: Duration = Duration::from_secs(600);
const REAP_AFTER: Duration = Duration::from_secs(60);

pub(super) async fn open_tab(
    browser: &Arc<Browser>,
    owner: &str,
    url: &str,
    args: &Value,
    budget: Duration,
) -> Result<Value, String> {
    let preview = preview_of(args);
    let profile = profile_of(args);
    let context = targets::context(browser, owner, preview).await?;
    let (target, session) = match browser.host() {
        Some(host) => host::open_hosted(host, owner, profile, &context, false).await?,
        None => targets::create(&browser.cdp, &browser.shared, &context).await?,
    };
    let id = {
        let mut state = browser.shared.lock();
        // A tab id the App reuses would replace a live tab: fail, close nothing.
        let Some(id) = host::tab_id(browser, &state.tabs, &session) else {
            return Err("browser_unavailable".into());
        };
        let mut tab = state::Tab::new(
            id.clone(),
            owner.to_owned(),
            target.clone(),
            session.clone(),
        );
        tab.policy = args["policy"].clone();
        tab.context = context;
        tab.preview = preview.map(str::to_owned);
        tab.profile = profile;
        state.tabs.insert(id.clone(), tab);
        state.sessions.insert(session.clone(), id.clone());
        id
    };
    browser.changed.notify_waiters();
    if targets::setup_page(&browser.cdp, &session).await.is_err() {
        targets::close(browser, &id).await;
        return Ok(json!({"status":"unknown","reason":"navigation_failed"}));
    }
    // The result returns once the document is parsed; images and late scripts
    // finish while the model reads it, and the next observation settles them.
    let Some(mut parsed) = browser.shared.with_tab(&id, |t| t.parsed.subscribe()) else {
        return Ok(json!({"status":"unknown","reason":"navigation_failed"}));
    };
    let navigated = browser
        .cdp
        .send("Page.navigate", json!({"url":url}), Some(&session))
        .await;
    let failed = navigated.as_ref().map_or(true, |n| {
        n["errorText"].as_str().is_some_and(|e| !e.is_empty())
    });
    if failed || browser.shared.with_tab(&id, |_| ()).is_none() {
        targets::close(browser, &id).await;
        return Ok(json!({"status":"unknown","reason":"navigation_failed"}));
    }
    let _ = tokio::time::timeout(budget, parsed.changed()).await;
    let info = target_info(browser, &id, &target, &session).await;
    let snapshot = browser.shared.with_tab(&id, |t| {
        if let Ok(u) = url::Url::parse(info["targetInfo"]["url"].as_str().unwrap_or(""))
            && matches!(u.scheme(), "http" | "https")
        {
            t.url = u.to_string();
        }
        if let Some(title) = info["targetInfo"]["title"].as_str() {
            t.title = title.to_owned();
        }
        t.last_call = Instant::now();
        json!({"status":"ok","tab":t.id,"url":t.url,"title":t.title,"epoch":t.epoch,"profile":t.profile})
    });
    Ok(snapshot.unwrap_or_else(|| json!({"status":"unknown","reason":"navigation_failed"})))
}

/// The URL and title a fresh tab shows. The App has no browser-level target
/// info: the tab's own state is current, and only a tab with no URL yet asks
/// its page for its main frame.
async fn target_info(browser: &Browser, id: &str, target: &str, session: &str) -> Value {
    if browser.host().is_none() {
        return browser
            .cdp
            .send("Target.getTargetInfo", json!({"targetId":target}), None)
            .await
            .unwrap_or_default();
    }
    if browser.shared.with_tab(id, |t| !t.url.is_empty()) != Some(false) {
        return Value::Null;
    }
    let tree = browser
        .cdp
        .send("Page.getFrameTree", json!({}), Some(session))
        .await
        .unwrap_or_default();
    json!({"targetInfo":{"url":tree["frameTree"]["frame"]["url"]}})
}

/// The profile a `tab.open` asks for.
pub(super) fn profile_of(args: &Value) -> &'static str {
    if args["profile"] == "signed_in" || args["signed_in"] == true {
        "signed_in"
    } else {
        "signed_out"
    }
}

/// The registered preview a `tab.open` shows: the gateway sets
/// `policy.preview` only for a preview this conversation owns.
pub(super) fn preview_of(args: &Value) -> Option<&str> {
    args["preview_id"]
        .as_str()
        .filter(|_| args["policy"]["preview"] == true)
}

/// Closes idle agent tabs and ends the process tree 60 s after the last tab.
pub(super) async fn janitor(owner: std::sync::Weak<Headless>, browser: Arc<Browser>) {
    let mut empty_since: Option<Instant> = None;
    let hosted = browser.host().is_some();
    loop {
        let notified = browser.changed.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        let now = Instant::now();
        let (expired, earliest, empty) = {
            let state = browser.shared.lock();
            let expired: Vec<String> = state
                .tabs
                .values()
                .filter(|t| !(hosted && t.waiting))
                .filter(|t| now.duration_since(t.last_call) >= TAB_IDLE)
                .map(|t| t.id.clone())
                .collect();
            let earliest = state
                .tabs
                .values()
                .filter(|t| !(hosted && t.waiting))
                .map(|t| t.last_call + TAB_IDLE)
                .min();
            (expired, earliest, state.tabs.is_empty())
        };
        for id in expired {
            targets::close(&browser, &id).await;
        }
        let since = if empty {
            *empty_since.get_or_insert(now)
        } else {
            empty_since = None;
            now
        };
        let reaps = !hosted;
        if empty && reaps && now.duration_since(since) >= REAP_AFTER {
            let Some(headless) = owner.upgrade() else {
                browser.stop().await;
                return;
            };
            let _start = headless.starting.lock().await;
            let idle = headless.in_flight.load(Ordering::SeqCst) == 0
                && browser.shared.lock().tabs.is_empty();
            if idle {
                headless.forget(&browser);
                browser.stop().await;
                return;
            }
            empty_since = Some(Instant::now());
            continue;
        }
        let wake = if empty && reaps {
            since + REAP_AFTER
        } else {
            earliest.unwrap_or(now + TAB_IDLE)
        };
        tokio::select! {
            () = tokio::time::sleep_until(wake.into()) => {},
            () = &mut notified => {},
            () = browser.alive.cancelled() => {
                // A new start waits until this browser has ended: both use the one profile.
                let owner = owner.upgrade();
                let _start = match &owner {
                    Some(headless) => Some(headless.starting.lock().await),
                    None => None,
                };
                if let Some(headless) = &owner {
                    headless.forget(&browser);
                }
                browser.stop().await;
                return;
            },
        }
    }
}

/// One call counted as in flight until it returns or its caller drops it
/// (a gateway deadline), so an abandoned call never keeps the browser alive.
pub(super) struct InFlight<'a>(&'a AtomicUsize);

impl<'a> InFlight<'a> {
    pub(super) fn enter(count: &'a AtomicUsize) -> Self {
        count.fetch_add(1, Ordering::SeqCst);
        Self(count)
    }
}

impl Drop for InFlight<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl Headless {
    pub(super) async fn ready(self: &Arc<Self>) -> Result<Arc<Browser>, Value> {
        if let Some(browser) = self.browser() {
            return Ok(browser);
        }
        if self.hosted {
            return Err(json!({"status":"unavailable","reason":"browser_unavailable"}));
        }
        // A started launch completes and registers its browser (and its
        // reap) even when the caller is gone, e.g. past a gateway deadline:
        // an abandoned launch would leave a browser running untracked.
        let headless = self.clone();
        self.wait_for_start(tokio::spawn(async move { headless.start().await }))
            .await
    }

    async fn wait_for_start(
        &self,
        start: tokio::task::JoinHandle<Result<Arc<Browser>, Value>>,
    ) -> Result<Arc<Browser>, Value> {
        // Bound the whole preparation, including installation and launch.
        // Dropping the join handle detaches startup; it still registers and reaps.
        match tokio::time::timeout(INSTALL_WAIT, start).await {
            Ok(result) => result.unwrap_or_else(|_| {
                Err(json!({"status":"unavailable","reason":"browser_unavailable"}))
            }),
            Err(_) => Err(self.preparing()),
        }
    }

    fn preparing(&self) -> Value {
        let mut result = json!({"status":"unavailable","reason":"browser_installing",
            "recovery":"The browser is being prepared for use. Retry browser_open shortly; nothing was opened."});
        if let Some(Progress::Running { received, total }) = self.installer.progress() {
            result["progress"] = json!({"received":received,"total":total});
        }
        result
    }

    async fn start(self: &Arc<Self>) -> Result<Arc<Browser>, Value> {
        let _start = self.starting.lock().await;
        if let Some(browser) = self.browser() {
            return Ok(browser);
        }
        // A browser whose pipe ended may still be exiting; it ends before another starts on the one profile.
        let ended = self
            .current
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(ended) = ended {
            ended.stop().await;
        }
        let executable = match self.installer.executable_within(INSTALL_WAIT).await {
            Progress::Ready(path) => path,
            Progress::Running { received, total } => {
                let mut result = self.preparing();
                result["progress"] = json!({"received":received,"total":total});
                return Err(result);
            }
            Progress::Failed(reason) => {
                return Err(json!({"status":"unavailable","reason":reason}));
            }
        };
        let browser = Browser::launch(
            &executable,
            &self.config.root,
            self.config.content,
            self.downloads.clone(),
            self.history.clone(),
        )
        .await
        .map_err(|reason| json!({"status":"unavailable","reason":reason}))?;
        if !self.enabled() {
            // Turned off while it started.
            browser.stop().await;
            return Err(json!({"status":"unavailable","reason":"no_browser"}));
        }
        *self.current.lock().unwrap_or_else(PoisonError::into_inner) = Some(browser.clone());
        tokio::spawn(janitor(Arc::downgrade(self), browser.clone()));
        Ok(browser)
    }
}
