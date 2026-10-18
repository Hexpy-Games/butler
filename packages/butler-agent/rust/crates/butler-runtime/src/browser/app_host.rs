//! The installed App's Electron as Butler's browser while the App is not
//! running: the hidden host. It runs the App's own browser executor with no
//! window, tray or Dock icon, and attaches to the gateway over the App's
//! browser-host channel, so the App path serves its calls unchanged.
//!
//! This type only starts it on first need, recognizes its attach (by a
//! per-launch id), and ends it: the gateway closes the channel, the host quits
//! on its own, and whatever still runs after a grace period is killed with its
//! whole tree. Each launch gets a throwaway profile, removed when it ends.
use butler_platform::app_browser::{self, AppElectron};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex, PoisonError},
    time::{Duration, Instant},
};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

/// A host that has not attached by then is ended; Electron starts in ~1 s.
const ATTACH_WITHIN: Duration = Duration::from_secs(20);
/// How long a host may take to quit after its channel closed.
const GRACE: Duration = Duration::from_secs(5);
/// After a failed start, Butler's headless browser serves meanwhile.
const RETRY_AFTER: Duration = Duration::from_secs(600);
const LOG_LIMIT: u64 = 1024 * 1024;

/// Which Electron runs the hidden host.
#[derive(Clone, Debug)]
pub enum AppHostSource {
    /// The installed App's, found when needed (an App installed later counts).
    Installed,
    /// This Electron (development and tests).
    Electron(AppElectron),
    /// None: Butler's headless browser serves without the App.
    Off,
}

pub struct AppHostConfig {
    /// Holds each launch's throwaway profile and the host log.
    pub root: PathBuf,
    pub source: AppHostSource,
}

/// How the host reaches the gateway's browser-host channel.
pub struct HostCredentials {
    pub url: String,
    pub token: String,
    pub admin: String,
}

struct Running {
    launch: String,
    stop: CancellationToken,
    ended: watch::Receiver<bool>,
}

pub struct AppHost {
    config: AppHostConfig,
    current: Mutex<Option<Running>>,
    starting: tokio::sync::Mutex<()>,
    closing: tokio::sync::Mutex<()>,
    attached: watch::Sender<Option<String>>,
    failed_at: Mutex<Option<Instant>>,
}

impl AppHost {
    pub fn new(config: AppHostConfig, shutdown: CancellationToken) -> Arc<Self> {
        let host = Arc::new(Self {
            config,
            current: Mutex::new(None),
            starting: tokio::sync::Mutex::new(()),
            closing: tokio::sync::Mutex::new(()),
            attached: watch::Sender::new(None),
            failed_at: Mutex::new(None),
        });
        let weak = Arc::downgrade(&host);
        tokio::spawn(async move {
            shutdown.cancelled().await;
            if let Some(host) = weak.upgrade() {
                host.stop().await;
            }
        });
        host
    }

    fn electron(&self) -> Option<AppElectron> {
        match &self.config.source {
            AppHostSource::Installed => app_browser::installed_app(),
            AppHostSource::Electron(electron) => Some(electron.clone()).filter(AppElectron::exists),
            AppHostSource::Off => None,
        }
    }

    /// The Electron to start, unless none is there or one failed lately.
    async fn usable(self: &Arc<Self>) -> Option<AppElectron> {
        let failed = *self
            .failed_at
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if failed.is_some_and(|at| at.elapsed() < RETRY_AFTER) {
            return None;
        }
        let host = self.clone();
        tokio::task::spawn_blocking(move || host.electron())
            .await
            .ok()
            .flatten()
    }

    /// Whether an App Electron is there to start (and none failed lately).
    pub async fn available(self: &Arc<Self>) -> bool {
        self.usable().await.is_some()
    }

    /// Whether a host process of this backend is alive.
    pub fn running(&self) -> bool {
        self.current
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
            .is_some_and(|r| !*r.ended.borrow())
    }

    /// Records the attach of the current launch; any other id is refused.
    pub fn admit(&self, launch: &str) -> bool {
        let current = self.current.lock().unwrap_or_else(PoisonError::into_inner);
        let admitted = current
            .as_ref()
            .is_some_and(|r| !launch.is_empty() && r.launch == launch && !*r.ended.borrow());
        if admitted {
            self.attached.send_replace(Some(launch.to_owned()));
        }
        admitted
    }

    /// Ends the current host's process tree when it exits: `None` without one.
    pub fn ended(&self) -> Option<watch::Receiver<bool>> {
        self.current
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
            .map(|r| r.ended.clone())
    }

    /// Starts the host and waits until it attached. `Err` names why it did
    /// not; the caller then serves without it.
    pub async fn start(self: &Arc<Self>, credentials: HostCredentials) -> Result<(), &'static str> {
        let _start = self.starting.lock().await;
        if self.running() && self.attached.borrow().is_some() {
            return Ok(());
        }
        let electron = self.usable().await.ok_or("app_unavailable")?;
        self.stop().await;
        let launch = uuid::Uuid::new_v4().to_string();
        let mut attached = self.attached.subscribe();
        self.attached.send_replace(None);
        let mut ended = self.spawn(&electron, &launch, &credentials).await?;
        let outcome = tokio::time::timeout(ATTACH_WITHIN, async {
            loop {
                if attached.borrow_and_update().as_deref() == Some(launch.as_str()) {
                    return Ok(());
                }
                tokio::select! {
                    changed = attached.changed() => if changed.is_err() { return Err("app_unavailable") },
                    _ = ended.wait_for(|ended| *ended) => return Err("app_exited"),
                }
            }
        })
        .await
        .unwrap_or(Err("app_start_timeout"));
        let ours = self
            .current
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
            .is_some_and(|r| r.launch == launch);
        // A launch ended from outside (turned off) is no failure.
        if outcome.is_err() && ours {
            *self
                .failed_at
                .lock()
                .unwrap_or_else(PoisonError::into_inner) = Some(Instant::now());
            self.stop().await;
        }
        outcome
    }

    async fn spawn(
        &self,
        electron: &AppElectron,
        launch: &str,
        credentials: &HostCredentials,
    ) -> Result<watch::Receiver<bool>, &'static str> {
        let root = self.config.root.clone();
        let (profile, log) = tokio::task::spawn_blocking(move || prepare(&root))
            .await
            .map_err(|_| "app_unavailable")?
            .map_err(|_| "app_unavailable")?;
        let flag = format!("--butler-browser-host={}", profile.display());
        let env = [
            ("BUTLER_BROWSER_HOST_URL", credentials.url.as_str()),
            ("BUTLER_BROWSER_HOST_TOKEN", credentials.token.as_str()),
            ("BUTLER_BROWSER_HOST_ADMIN", credentials.admin.as_str()),
            ("BUTLER_BROWSER_HOST_LAUNCH", launch),
        ];
        let Ok(mut process) = app_browser::spawn(electron, &[flag.into()], &env, &log) else {
            let _ = tokio::fs::remove_dir_all(&profile).await;
            return Err("app_unavailable");
        };
        let stop = CancellationToken::new();
        let (done, ended) = watch::channel(false);
        let stopping = stop.clone();
        tokio::spawn(async move {
            let quit = async {
                stopping.cancelled().await;
                tokio::time::sleep(GRACE).await;
            };
            tokio::select! {
                () = process.wait() => {}
                () = quit => {}
            }
            process.kill().await;
            let _ = tokio::task::spawn_blocking(move || std::fs::remove_dir_all(profile)).await;
            done.send_replace(true);
        });
        *self.current.lock().unwrap_or_else(PoisonError::into_inner) = Some(Running {
            launch: launch.to_owned(),
            stop,
            ended: ended.clone(),
        });
        Ok(ended)
    }

    /// Ends the current host: its channel is already closed, so it quits on
    /// its own; after the grace period its tree is killed. Waits until gone.
    pub async fn stop(&self) {
        let _closing = self.closing.lock().await;
        let running = self
            .current
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        self.attached.send_replace(None);
        if let Some(mut running) = running {
            running.stop.cancel();
            let _ = running.ended.wait_for(|ended| *ended).await;
        }
    }
}

/// A fresh profile directory and the host log; profiles of a run that ended
/// without its cleanup hold nothing worth keeping.
fn prepare(root: &Path) -> std::io::Result<(PathBuf, PathBuf)> {
    std::fs::create_dir_all(root)?;
    for entry in std::fs::read_dir(root)?.flatten() {
        if entry.file_name().to_string_lossy().starts_with("profile-") {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
    let profile = root.join(format!("profile-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&profile)?;
    let log = root.join("host.log");
    if std::fs::metadata(&log).is_ok_and(|m| m.len() > LOG_LIMIT) {
        let _ = std::fs::remove_file(&log);
    }
    Ok((profile, log))
}
