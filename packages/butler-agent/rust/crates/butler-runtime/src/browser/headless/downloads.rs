//! Conversation downloads on the headless browser, with the App's semantics
//! (#745, `downloads.mjs`): a file lands in the conversation's workspace
//! under `downloads/`, becomes a session output, and is never opened.
//! Limits: 100 MB per file, 500 MB per conversation (persisted), checked
//! while the transfer runs; a breach cancels it and says so.
use super::{browser::Browser, state::State};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    future::Future,
    io,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{Arc, Mutex, PoisonError},
};

pub const FILE_LIMIT: u64 = 100_000_000;
pub const SESSION_LIMIT: u64 = 500_000_000;

pub type PortFuture = Pin<Box<dyn Future<Output = Result<Value, String>> + Send>>;

/// The gateway side: the conversation's download workspace and publication.
pub trait DownloadPort: Send + Sync {
    /// `{workspace_path, turn_id, message_id}` for the conversation.
    fn prepare(&self, session: String) -> PortFuture;
    /// Publishes `downloads/<filename>` as a session output: `{output_id, view}`.
    fn publish(
        &self,
        session: String,
        filename: String,
        turn_id: String,
        message_id: String,
    ) -> PortFuture;
}

#[derive(Clone)]
struct Transfer {
    tab: String,
    owner: String,
    epoch: u64,
    context: String,
    source: String,
    total: u64,
    received: u64,
    refused: bool,
}

/// Download accounting that outlives any one browser process.
pub(crate) struct Downloads {
    pub stage: PathBuf,
    queue: Mutex<Option<tokio::sync::mpsc::UnboundedSender<(String, Value)>>>,
    budget: PathBuf,
    port: Mutex<Option<Arc<dyn DownloadPort>>>,
    active: Mutex<HashMap<String, Transfer>>,
    totals: Mutex<HashMap<String, u64>>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The App's filename rule: last path part, no control or reserved characters.
fn clean_name(source: &str) -> String {
    let clean: String = source
        .chars()
        .map(|c| if (c as u32) < 32 { '_' } else { c })
        .collect();
    let last = clean.rsplit(['/', '\\']).next().unwrap_or("");
    let replaced: String = last
        .chars()
        .map(|c| if "<>:\"|?*".contains(c) { '_' } else { c })
        .collect();
    let mut name = replaced.trim_end_matches(['.', ' ']).to_owned();
    if name.is_empty() {
        name = "download".into();
    }
    while name.len() > 180 {
        name.pop();
    }
    let lower = name.to_ascii_lowercase();
    let stem = lower.split('.').next().unwrap_or("");
    let reserved = matches!(stem, "con" | "prn" | "aux" | "nul")
        || (stem.len() == 4
            && (stem.starts_with("com") || stem.starts_with("lpt"))
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0');
    if reserved {
        name.insert(0, '_');
    }
    name
}

/// Copies without ever replacing an existing path.
fn copy_new(from: &Path, to: &Path) -> io::Result<()> {
    let mut source = std::fs::File::open(from)?;
    let mut target = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(to)?;
    io::copy(&mut source, &mut target)?;
    target.sync_all()
}

impl Downloads {
    pub(crate) fn new(root: &Path) -> Arc<Self> {
        let directory = root.join("downloads");
        let totals = std::fs::read(directory.join("budget.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<HashMap<String, u64>>(&bytes).ok())
            .unwrap_or_default();
        Arc::new(Self {
            stage: directory.join("stage"),
            budget: directory.join("budget.json"),
            port: Mutex::new(None),
            queue: Mutex::new(None),
            active: Mutex::new(HashMap::new()),
            totals: Mutex::new(totals),
        })
    }

    pub(crate) fn set_port(&self, port: Arc<dyn DownloadPort>) {
        *lock(&self.port) = Some(port);
    }

    /// Handles one browser's download events in arrival order.
    pub(crate) fn attach(self: &Arc<Self>, browser: &Arc<Browser>) {
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel::<(String, Value)>();
        *lock(&self.queue) = Some(sender);
        let downloads = self.clone();
        let browser = Arc::downgrade(browser);
        tokio::spawn(async move {
            while let Some((method, params)) = receiver.recv().await {
                let Some(browser) = browser.upgrade() else {
                    break;
                };
                if method == "Browser.downloadWillBegin" {
                    downloads.begin(&browser, &params).await;
                } else {
                    downloads.progress(&browser, &params).await;
                }
            }
        });
    }

    pub(crate) fn queue(&self, method: &str, params: Value) {
        if let Some(sender) = lock(&self.queue).as_ref() {
            let _ = sender.send((method.to_owned(), params));
        }
    }

    pub(crate) fn available(&self) -> bool {
        lock(&self.port).is_some()
    }

    /// Why this many bytes for `owner` may not land, if they may not.
    fn limit(&self, owner: &str, guid: &str, bytes: u64) -> Option<&'static str> {
        if bytes > FILE_LIMIT {
            return Some("download_file_limit");
        }
        let used = lock(&self.totals).get(owner).copied().unwrap_or(0);
        let pending: u64 = lock(&self.active)
            .iter()
            .filter(|(id, t)| *id != guid && t.owner == owner)
            .map(|(_, t)| t.total.max(t.received))
            .sum();
        (used + pending + bytes > SESSION_LIMIT).then_some("download_session_limit")
    }

    fn event(browser: &Browser, transfer: &Transfer, kind: &str, data: &Value) {
        let mut state = browser.shared.lock();
        owner_event(&mut state, transfer, kind, data);
    }

    async fn refuse(&self, browser: &Browser, guid: &str, reason: &str) {
        let transfer = {
            let mut active = lock(&self.active);
            let Some(transfer) = active.get_mut(guid).filter(|t| !t.refused) else {
                return;
            };
            transfer.refused = true;
            (transfer.context.clone(), transfer.clone())
        };
        Self::event(
            browser,
            &transfer.1,
            "download_refused",
            &json!({"reason":reason,"file_limit_bytes":FILE_LIMIT,"session_limit_bytes":SESSION_LIMIT}),
        );
        let _ = browser
            .cdp
            .send(
                "Browser.cancelDownload",
                json!({"guid":guid,"browserContextId":transfer.0}),
                None,
            )
            .await;
    }

    /// `Browser.downloadWillBegin`: the transfer belongs to the frame's tab.
    pub(crate) async fn begin(self: &Arc<Self>, browser: &Arc<Browser>, params: &Value) {
        let guid = params["guid"].as_str().unwrap_or("").to_owned();
        let frame = params["frameId"].as_str().unwrap_or("");
        let tab = {
            let state = browser.shared.lock();
            state
                .tabs
                .values()
                .find(|t| t.hidden.is_none() && (t.target == frame || t.frames.contains_key(frame)))
                .map(|t| (t.id.clone(), t.owner.clone(), t.epoch, t.context.clone()))
        };
        let Some((tab, owner, epoch, context)) = tab else {
            let _ = browser
                .cdp
                .send("Browser.cancelDownload", json!({"guid":guid}), None)
                .await;
            return;
        };
        let source = params["suggestedFilename"]
            .as_str()
            .unwrap_or("")
            .to_owned();
        lock(&self.active).insert(
            guid.clone(),
            Transfer {
                tab,
                owner: owner.clone(),
                epoch,
                context,
                source,
                total: 0,
                received: 0,
                refused: false,
            },
        );
        if !self.available() {
            self.refuse(browser, &guid, "download_workspace_unavailable")
                .await;
        }
    }

    /// `Browser.downloadProgress`: limits while it runs, landing when done.
    pub(crate) async fn progress(self: &Arc<Self>, browser: &Arc<Browser>, params: &Value) {
        let guid = params["guid"].as_str().unwrap_or("").to_owned();
        let (owner, bytes) = {
            let mut active = lock(&self.active);
            let Some(transfer) = active.get_mut(&guid) else {
                return;
            };
            transfer.total = params["totalBytes"].as_u64().unwrap_or(0);
            transfer.received = params["receivedBytes"].as_u64().unwrap_or(0);
            (
                transfer.owner.clone(),
                transfer.total.max(transfer.received),
            )
        };
        match params["state"].as_str() {
            Some("inProgress") => {
                if let Some(reason) = self.limit(&owner, &guid, bytes) {
                    self.refuse(browser, &guid, reason).await;
                }
            }
            Some("completed") => self.finish(browser, &guid).await,
            _ => {
                let transfer = lock(&self.active).remove(&guid);
                if let Some(transfer) = transfer.filter(|t| !t.refused) {
                    Self::event(
                        browser,
                        &transfer,
                        "download_failed",
                        &json!({"reason":"download_interrupted"}),
                    );
                }
                let _ = std::fs::remove_file(self.stage.join(&guid));
            }
        }
    }

    async fn finish(&self, browser: &Browser, guid: &str) {
        let staged = self.stage.join(guid);
        let transfer = lock(&self.active).remove(guid);
        if let Some(transfer) = transfer.filter(|t| !t.refused) {
            let reason = self.limit(&transfer.owner, guid, transfer.received);
            let outcome = match reason {
                Some(reason) => Err(reason.to_owned()),
                None => self.land(&transfer, &staged).await,
            };
            match outcome {
                Ok(data) => Self::event(browser, &transfer, "download_completed", &data),
                Err(reason) if reason.starts_with("download_") && reason.ends_with("limit") => {
                    Self::event(
                        browser,
                        &transfer,
                        "download_refused",
                        &json!({"reason":reason,"file_limit_bytes":FILE_LIMIT,"session_limit_bytes":SESSION_LIMIT}),
                    );
                }
                Err(_) => Self::event(
                    browser,
                    &transfer,
                    "download_failed",
                    &json!({"reason":"download_storage_failed"}),
                ),
            }
        }
        let _ = std::fs::remove_file(staged);
    }

    /// Copies into `<workspace>/downloads/`, accounts it, then publishes it.
    async fn land(&self, transfer: &Transfer, staged: &Path) -> Result<Value, String> {
        let port = lock(&self.port)
            .clone()
            .ok_or("download_workspace_unavailable")?;
        let session = transfer
            .owner
            .strip_prefix("conversation:")
            .unwrap_or("")
            .to_owned();
        let context = port.prepare(session.clone()).await?;
        let root = std::fs::canonicalize(context["workspace_path"].as_str().unwrap_or(""))
            .map_err(|e| e.to_string())?;
        let directory = root.join("downloads");
        std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        if std::fs::canonicalize(&directory).map_err(|e| e.to_string())? != directory {
            return Err("download_symlink_refused".into());
        }
        let mut name = clean_name(&transfer.source);
        if copy_new(staged, &directory.join(&name)).is_err() {
            name = format!("{}-{name}", uuid::Uuid::new_v4());
            copy_new(staged, &directory.join(&name)).map_err(|e| e.to_string())?;
        }
        self.account(&transfer.owner, transfer.received)?;
        let output = port
            .publish(
                session,
                name.clone(),
                context["turn_id"].as_str().unwrap_or("").to_owned(),
                context["message_id"].as_str().unwrap_or("").to_owned(),
            )
            .await?;
        let mut data = json!({"path":format!("downloads/{name}"),"size_bytes":transfer.received});
        if let (Some(target), Some(output)) = (data.as_object_mut(), output.as_object()) {
            target.extend(output.clone());
        }
        Ok(data)
    }

    fn account(&self, owner: &str, bytes: u64) -> Result<(), String> {
        let snapshot = {
            let mut totals = lock(&self.totals);
            *totals.entry(owner.to_owned()).or_insert(0) += bytes;
            serde_json::to_vec(&*totals).map_err(|e| e.to_string())?
        };
        if let Some(parent) = self.budget.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let temporary = self.budget.with_extension("json.tmp");
        std::fs::write(&temporary, snapshot).map_err(|e| e.to_string())?;
        std::fs::rename(&temporary, &self.budget).map_err(|e| e.to_string())
    }
}

fn owner_event(state: &mut State, transfer: &Transfer, kind: &str, data: &Value) {
    let mut event = json!({"type":kind,"tab":transfer.tab,"epoch":transfer.epoch});
    if let (Some(target), Some(data)) = (event.as_object_mut(), data.as_object()) {
        target.extend(data.clone());
    }
    state
        .events
        .entry(transfer.owner.clone())
        .or_default()
        .push(event);
}
