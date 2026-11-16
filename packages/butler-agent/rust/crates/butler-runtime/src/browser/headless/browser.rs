//! One headless browser process tree: launched on demand, sandboxed, its
//! egress through the guard proxy, its profile one reused directory; pages live in
//! disposable contexts, so it holds no site state.
use super::{cdp::Cdp, page::Page, state::Shared};
use crate::browser::egress::{ContentOrigin, EgressProxy};
use butler_platform::browser_process::{self, PipeBrowser};
use butler_platform::process_control::{Liveness, liveness};
use serde_json::json;
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, PoisonError},
    time::Duration,
};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

pub(crate) struct Browser {
    pub cdp: Arc<Cdp>,
    pub shared: Shared,
    pub content: Option<ContentOrigin>,
    pub proxy_url: String,
    /// The proxy of registered previews' tabs (their own contexts).
    pub preview_proxy_url: Option<String>,
    /// Cancelled when the browser's pipe ends.
    pub alive: CancellationToken,
    /// Signals a change in the set of tabs (for expiry and the idle reap).
    pub changed: Notify,
    pub history: Arc<super::history::History>,
    pub downloads: Arc<super::downloads::Downloads>,
    /// Held while a conversation's browser context is created, so tabs
    /// opened at once by one conversation share its one context.
    pub contexts_created: tokio::sync::Mutex<()>,
    process: Mutex<Option<PipeBrowser>>,
    _proxy: EgressProxy,
    _preview_proxy: Option<EgressProxy>,
}

const LOG_LIMIT: u64 = 1024 * 1024;

fn arguments(profile: &Path, proxy: &str) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec![
        "--remote-debugging-pipe".into(),
        format!("--user-data-dir={}", profile.display()).into(),
        format!("--proxy-server={proxy}").into(),
        // Loopback goes through the proxy too: only Butler's output origin passes.
        "--proxy-bypass-list=<-loopback>".into(),
        // The browser resolves no names itself; the proxy resolves and checks them.
        "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1".into(),
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp".into(),
        "--disable-quic".into(),
    ];
    // Background services and Google calls off: the list the in-app browser shares.
    args.extend(butler_cef_host::switches::quiet_args().map(OsString::from));
    args.extend(
        [
            "--password-store=basic",
            "--use-mock-keychain",
            "--mute-audio",
            "--window-size=1280,800",
            "about:blank",
        ]
        .map(OsString::from),
    );
    args
}

fn prepare(root: &Path) -> std::io::Result<(PathBuf, PathBuf)> {
    std::fs::create_dir_all(root)?;
    // Per-run profiles of earlier builds, left by a run that ended without its reap.
    for entry in std::fs::read_dir(root)?.flatten() {
        if entry.file_name().to_string_lossy().starts_with("profile-") {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
    let profile = root.join("profile");
    std::fs::create_dir_all(&profile)?;
    // A killed browser leaves Chrome's singleton lock behind. Only this agent's one browser uses
    // the profile and `stop` waits for it to end, so a lock found here is stale; one naming
    // another hostname would make Chrome refuse the profile.
    for name in ["SingletonLock", "SingletonCookie", "SingletonSocket"] {
        let _ = std::fs::remove_file(profile.join(name));
    }
    let log = root.join("browser.log");
    if std::fs::metadata(&log).is_ok_and(|m| m.len() > LOG_LIMIT) {
        let _ = std::fs::remove_file(&log);
    }
    Ok((profile, log))
}

fn failure(log: &Path) -> &'static str {
    let text = std::fs::read_to_string(log).unwrap_or_default();
    if text.contains("sandbox")
        && (text.contains("No usable sandbox") || text.contains("setuid sandbox"))
    {
        "sandbox_unavailable"
    } else {
        "browser_unavailable"
    }
}

impl Browser {
    pub(crate) async fn launch(
        executable: &Path,
        root: &Path,
        content: Option<ContentOrigin>,
        downloads: Arc<super::downloads::Downloads>,
        history: Arc<super::history::History>,
    ) -> Result<Arc<Self>, &'static str> {
        let (profile, log) = prepare(root).map_err(|_| "browser_unavailable")?;
        let proxy = EgressProxy::start(content)
            .await
            .map_err(|_| "browser_unavailable")?;
        let proxy_url = proxy.url();
        let preview_proxy = match content {
            Some(content) => Some(
                EgressProxy::start_preview(content)
                    .await
                    .map_err(|_| "browser_unavailable")?,
            ),
            None => None,
        };
        let mut process =
            browser_process::spawn(executable, &arguments(&profile, &proxy_url), &log)
                .map_err(|_| "browser_unavailable")?;
        let incoming = process.incoming.take().ok_or("browser_unavailable")?;
        let (cdp, mut events) = Cdp::start(incoming, process.outgoing.clone());
        let identity = tokio::time::timeout(
            Duration::from_secs(15),
            super::identity::read(&cdp, &mut events),
        )
        .await
        .map_err(|_| "browser_identity_unavailable")?
        .map_err(|_| "browser_identity_unavailable")?;
        let _ = cdp.identity.set(identity);
        let browser = Arc::new(Self {
            cdp,
            shared: Shared::default(),
            content,
            proxy_url,
            preview_proxy_url: preview_proxy.as_ref().map(EgressProxy::url),
            alive: CancellationToken::new(),
            changed: Notify::new(),
            downloads: downloads.clone(),
            history,
            contexts_created: tokio::sync::Mutex::new(()),
            process: Mutex::new(Some(process)),
            _proxy: proxy,
            _preview_proxy: preview_proxy,
        });
        let _ = std::fs::create_dir_all(&downloads.stage);
        downloads.attach(&browser);
        tokio::spawn(super::events::run(browser.clone(), events));
        if let Err(_error) = browser.attach_root().await {
            let reason = failure(&log);
            browser.stop().await;
            return Err(reason);
        }
        Ok(browser)
    }

    async fn attach_root(&self) -> Result<(), String> {
        self.cdp
            .send("Target.setDiscoverTargets", json!({"discover":true}), None)
            .await?;
        self.cdp
            .send(
                "Target.setAutoAttach",
                json!({"autoAttach":true,"waitForDebuggerOnStart":true,"flatten":true}),
                None,
            )
            .await?;
        // The startup page belongs to no conversation.
        let targets = self.cdp.send("Target.getTargets", json!({}), None).await?;
        for target in targets["targetInfos"].as_array().into_iter().flatten() {
            if target["type"] == "page" {
                let _ = self
                    .cdp
                    .send(
                        "Target.closeTarget",
                        json!({"targetId":target["targetId"]}),
                        None,
                    )
                    .await;
            }
        }
        Ok(())
    }

    pub(crate) fn page(&self, tab: &str) -> Option<Page> {
        let state = self.shared.lock();
        let entry = state.tabs.get(tab)?;
        Some(Page {
            cdp: self.cdp.clone(),
            shared: self.shared.clone(),
            tab: entry.id.clone(),
            session: entry.session.clone(),
            target: entry.target.clone(),
        })
    }

    /// Ends the browser's whole process tree; its reused profile stays.
    pub(crate) async fn stop(&self) {
        // No `Browser.close` first: on Linux and Windows the CEF host keeps running after it, so it
        // only delayed the kill, and the profile holds nothing a clean exit would save.
        let process = self
            .process
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        let pid = process.map(|mut process| {
            let pid = process.pid();
            process.kill();
            pid
        });
        self.alive.cancel();
        // The cap is only a guard; the next start must not meet a browser still
        // exiting with the same profile open.
        for _ in 0..300 {
            // Windows ends the tree asynchronously after its Job Object closes.
            if pid.is_none_or(|pid| liveness(pid) == Liveness::Gone) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
}

impl Drop for Browser {
    fn drop(&mut self) {
        if let Some(mut process) = self
            .process
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
        {
            process.kill();
        }
    }
}
