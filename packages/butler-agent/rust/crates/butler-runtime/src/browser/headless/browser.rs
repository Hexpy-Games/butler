//! One headless browser process tree: launched on demand, sandboxed, its
//! egress through the guard proxy, its profile a throwaway directory.
use super::{cdp::Cdp, page::Page, state::Shared};
use crate::browser::egress::{ContentOrigin, EgressProxy};
use butler_platform::browser_process::{self, PipeBrowser};
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
    /// Cancelled when the browser's pipe ends.
    pub alive: CancellationToken,
    /// Signals a change in the set of tabs (for expiry and the idle reap).
    pub changed: Notify,
    pub downloads: Arc<super::downloads::Downloads>,
    process: Mutex<Option<PipeBrowser>>,
    _proxy: EgressProxy,
    profile: PathBuf,
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
        "--no-first-run".into(),
        "--no-default-browser-check".into(),
        "--disable-background-networking".into(),
        "--disable-component-update".into(),
        "--disable-sync".into(),
        "--disable-breakpad".into(),
        "--disable-crash-reporter".into(),
        "--disable-domain-reliability".into(),
        "--disable-features=Translate,MediaRouter,OptimizationHints,DialMediaRouteProvider".into(),
        "--password-store=basic".into(),
        "--use-mock-keychain".into(),
        "--mute-audio".into(),
        "--window-size=1280,800".into(),
    ];
    args.push("about:blank".into());
    args
}

fn prepare(root: &Path) -> std::io::Result<(PathBuf, PathBuf)> {
    std::fs::create_dir_all(root)?;
    // Profiles of a run that ended without its reap hold nothing worth keeping.
    for entry in std::fs::read_dir(root)?.flatten() {
        if entry.file_name().to_string_lossy().starts_with("profile-") {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
    let profile = root.join(format!("profile-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&profile)?;
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
    ) -> Result<Arc<Self>, &'static str> {
        let (profile, log) = prepare(root).map_err(|_| "browser_unavailable")?;
        let proxy = EgressProxy::start(content)
            .await
            .map_err(|_| "browser_unavailable")?;
        let proxy_url = proxy.url();
        let mut process =
            browser_process::spawn(executable, &arguments(&profile, &proxy_url), &log)
                .map_err(|_| "browser_unavailable")?;
        let incoming = process.incoming.take().ok_or("browser_unavailable")?;
        let (cdp, events) = Cdp::start(incoming, process.outgoing.clone());
        let browser = Arc::new(Self {
            cdp,
            shared: Shared::default(),
            content,
            proxy_url,
            alive: CancellationToken::new(),
            changed: Notify::new(),
            downloads: downloads.clone(),
            process: Mutex::new(Some(process)),
            _proxy: proxy,
            profile,
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

    /// Closes the browser, ends its whole process tree and removes its profile.
    pub(crate) async fn stop(&self) {
        let _ = tokio::time::timeout(
            Duration::from_secs(2),
            self.cdp.send("Browser.close", json!({}), None),
        )
        .await;
        let _ = tokio::time::timeout(Duration::from_secs(3), self.alive.cancelled()).await;
        let process = self
            .process
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(mut process) = process {
            process.kill();
        }
        self.alive.cancel();
        for _ in 0..10 {
            if std::fs::remove_dir_all(&self.profile).is_ok() || !self.profile.exists() {
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
        let _ = std::fs::remove_dir_all(&self.profile);
    }
}
