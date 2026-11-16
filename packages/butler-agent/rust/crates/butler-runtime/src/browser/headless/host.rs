//! Hosted mode: the App owns the pages, this executor asks it to open, close
//! and hold them and exchanges per-page DevTools messages over byte channels.
use super::{Headless, HeadlessConfig, InstallSource, browser::Browser, lifecycle, page::Page};
use crate::browser::egress::ContentOrigin;
use serde_json::{Value, json};
use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, PoisonError},
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// Where pages come from when an attached App owns them (signed-in profile, the user's tab list).
pub trait PageHost: Send + Sync {
    /// `page.open` | `page.close` | `page.hold`; answers the host's result object.
    fn call(
        &self,
        op: &'static str,
        args: Value,
    ) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send + '_>>;
}

impl Headless {
    /// The backend over an App's pages: its one browser is connected from the
    /// start, and nothing is installed, launched or reaped.
    pub fn hosted(
        host: Arc<dyn PageHost>,
        incoming: mpsc::Receiver<Vec<u8>>,
        outgoing: mpsc::Sender<Vec<u8>>,
        content: Option<ContentOrigin>,
        shutdown: CancellationToken,
    ) -> Arc<Self> {
        // Never used: no profile, log, download stage or install lives here.
        let unused = std::env::temp_dir().join("butler-hosted-browser");
        let headless = Self::assemble(
            HeadlessConfig {
                root: unused.clone(),
                install: InstallSource {
                    cache_root: unused,
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

/// `tab.wait`: with the App, the user takes the tab over; otherwise the wait is already over.
pub(super) async fn wait(
    browser: &Browser,
    page: &Page,
    args: &Value,
    turn: Option<String>,
    epoch: u64,
) -> Value {
    let id = page.tab.as_str();
    let dialog = page
        .shared
        .with_tab(id, |t| {
            t.waiting_turn = turn;
            t.waiting = t.dialog.is_some();
            t.dialog.is_some()
        })
        .unwrap_or(false);
    if let (false, Some(host)) = (dialog, browser.host()) {
        let hold = json!({"tab":id,"holder":"user","sticky":true,"reason":args["reason"]});
        return match host.call("page.hold", hold).await {
            Ok(_) => json!({"status":"user_control","tab":id,"epoch":epoch}),
            Err(_) => json!({"status":"unknown","reason":"browser_unavailable"}),
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
    let waiting = page
        .shared
        .with_tab(id, |t| {
            t.waiting_turn = turn;
            t.waiting = t.dialog.is_some() || args["value"] == true;
            t.waiting
        })
        .unwrap_or(false);
    if let Some(host) = browser.host() {
        let _ = host
            .call("page.hold", json!({"tab":id,"waiting":waiting}))
            .await;
    }
    json!({"status":"ok"})
}
