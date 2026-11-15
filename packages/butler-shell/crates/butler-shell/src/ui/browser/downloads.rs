//! Conversation transfers: synchronous destinations, background storage and publication.
mod storage;
use super::engine::TabId;
use crate::ui::source::agent::Jobs;
use butler_cef_host::osr::{DownloadDecision, DownloadPolicy, OsrEvent, OsrRuntime};
use futures::{
    StreamExt as _,
    channel::{mpsc, oneshot},
};
use gpui::{App, Global};
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    collections::HashMap,
    fs,
    path::PathBuf,
    rc::Rc,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use storage::{failure, transfer};

const FILE_LIMIT: u64 = 100_000_000;
const SESSION_LIMIT: u64 = 500_000_000;
type Totals = HashMap<String, u64>;
type Budget = Arc<Mutex<Option<Totals>>>;
#[derive(Clone)]
struct Origin {
    page: u64,
    tab: TabId,
    owner: String,
    epoch: u64,
    stage: PathBuf,
    cancelled: Arc<AtomicBool>,
    accounted: Arc<AtomicBool>,
}
struct Transfer {
    origin: Origin,
    received: u64,
    total: u64,
    reason: Option<&'static str>,
    done: Option<oneshot::Sender<(bool, u64)>>,
}
enum Notice {
    Budget(Totals, oneshot::Sender<()>),
    Event(Origin, Value),
}
struct State {
    pages: HashMap<u64, (TabId, String, u64)>,
    active: HashMap<u32, Transfer>,
    totals: Totals,
    events: HashMap<String, Vec<Value>>,
    budget: Budget,
    path: PathBuf,
    notices: mpsc::UnboundedSender<Notice>,
}
#[derive(Clone)]
pub(crate) struct Downloads(Rc<RefCell<State>>);
impl Global for Downloads {}
impl Downloads {
    pub(super) fn new(cx: &mut App) -> Self {
        let (notices, mut receive) = mpsc::unbounded();
        let path = crate::lifecycle::data_root(&std::env::args_os().collect::<Vec<_>>())
            .join("app/browser/budget.json");
        let downloads = Self(Rc::new(RefCell::new(State {
            pages: HashMap::new(),
            active: HashMap::new(),
            totals: HashMap::new(),
            events: HashMap::new(),
            budget: Arc::default(),
            path,
            notices,
        })));
        let state = downloads.clone();
        cx.spawn(async move |cx| {
            while let Some(notice) = receive.next().await {
                cx.update(|cx| match notice {
                    Notice::Budget(totals, ack) => {
                        let ids = {
                            let mut inner = state.0.borrow_mut();
                            for (owner, total) in totals {
                                let used = inner.totals.entry(owner).or_default();
                                *used = (*used).max(total);
                            }
                            inner.active.keys().copied().collect::<Vec<_>>()
                        };
                        let runtime = cx.global::<DownloadsRuntime>().0.clone();
                        for id in ids {
                            if let Some(reason) = state.limit(id) {
                                state.cancel(id, reason, &runtime);
                            }
                        }
                        let _ = ack.send(());
                    }
                    Notice::Event(origin, event) => state.notify(&origin, event, cx),
                });
            }
        })
        .detach();
        cx.set_global(downloads.clone());
        downloads
    }
    pub(super) fn policy(&self) -> DownloadPolicy {
        let state = self.clone();
        Rc::new(move |request| {
            let mut state = state.0.borrow_mut();
            let Some((tab, owner, epoch)) = state.pages.get(&request.page).cloned() else {
                return DownloadDecision::Dialog;
            };
            if owner == "mine" {
                return DownloadDecision::Dialog;
            }
            let stage =
                std::env::temp_dir().join(format!("butler-download-{}", uuid::Uuid::new_v4()));
            state.active.insert(
                request.id,
                Transfer {
                    origin: Origin {
                        page: request.page,
                        tab,
                        owner,
                        epoch,
                        stage: stage.clone(),
                        cancelled: Arc::default(),
                        accounted: Arc::default(),
                    },
                    received: 0,
                    total: request.total_bytes,
                    reason: None,
                    done: None,
                },
            );
            DownloadDecision::Stage(stage)
        })
    }
    pub(super) fn page(&self, page: u64, tab: &TabId, owner: &str, epoch: u64) {
        self.0
            .borrow_mut()
            .pages
            .insert(page, (tab.clone(), owner.to_owned(), epoch));
    }
    pub(super) fn cancel_page(&self, page: u64, runtime: &OsrRuntime) {
        let ids: Vec<_> = self
            .0
            .borrow()
            .active
            .iter()
            .filter(|(_, t)| t.origin.page == page)
            .map(|(id, _)| *id)
            .collect();
        for id in ids {
            self.cancel(id, "download_cancelled", runtime);
        }
    }
    pub(super) fn next_epoch(&self, page: u64) -> u64 {
        self.0.borrow().pages.get(&page).map_or(1, |p| p.2 + 1)
    }
    pub(super) fn remove_page(&self, page: u64) {
        self.0.borrow_mut().pages.remove(&page);
    }
    fn limit(&self, id: u32) -> Option<&'static str> {
        let state = self.0.borrow();
        let transfer = state.active.get(&id)?;
        if transfer.origin.accounted.load(Ordering::Acquire) || transfer.reason.is_some() {
            return None;
        }
        let bytes = transfer.received.max(transfer.total);
        if bytes > FILE_LIMIT {
            return Some("download_file_limit");
        }
        let pending: u64 = state
            .active
            .iter()
            .filter(|(other, t)| {
                **other != id
                    && t.origin.owner == transfer.origin.owner
                    && t.reason.is_none()
                    && !t.origin.accounted.load(Ordering::Acquire)
            })
            .map(|(_, t)| t.received.max(t.total))
            .sum();
        (state
            .totals
            .get(&transfer.origin.owner)
            .copied()
            .unwrap_or(0)
            + pending
            + bytes
            > SESSION_LIMIT)
            .then_some("download_session_limit")
    }
    fn cancel(&self, id: u32, reason: &'static str, runtime: &OsrRuntime) {
        let (origin, done) = {
            let mut state = self.0.borrow_mut();
            let Some(transfer) = state.active.get_mut(&id) else {
                return;
            };
            if transfer.reason.is_some() {
                return;
            }
            transfer.reason = Some(reason);
            transfer.origin.cancelled.store(true, Ordering::Release);
            (transfer.origin.clone(), transfer.done.take())
        };
        runtime.cancel_download(origin.page, id);
        if let Some(done) = done {
            let _ = done.send((false, 0));
        }
        let event = json!({"type":"download_refused","reason":reason,"file_limit_bytes":FILE_LIMIT,"session_limit_bytes":SESSION_LIMIT});
        let _ = self
            .0
            .borrow()
            .notices
            .unbounded_send(Notice::Event(origin, event));
    }
    pub(super) fn event(&self, event: &OsrEvent, runtime: &OsrRuntime, cx: &mut App) -> bool {
        match event {
            OsrEvent::DownloadStarted {
                id, suggested_name, ..
            } => {
                if self.0.borrow().active.contains_key(id) {
                    self.start(*id, suggested_name.clone(), runtime, cx);
                }
            }
            OsrEvent::DownloadProgress {
                id,
                received,
                total,
            } => {
                if let Some(transfer) = self.0.borrow_mut().active.get_mut(id) {
                    transfer.received = *received;
                    transfer.total = *total;
                }
                if let Some(reason) = self.limit(*id) {
                    self.cancel(*id, reason, runtime);
                }
            }
            OsrEvent::DownloadDone { id, completed } => {
                if let Some(transfer) = self.0.borrow_mut().active.get_mut(id)
                    && let Some(done) = transfer.done.take()
                {
                    let _ = done.send((*completed, transfer.received));
                }
            }
            _ => return false,
        }
        true
    }
    fn start(&self, id: u32, name: String, runtime: &OsrRuntime, cx: &mut App) {
        let (send, receive) = oneshot::channel();
        let (origin, budget, path, notices) = {
            let mut state = self.0.borrow_mut();
            let Some(transfer) = state.active.get_mut(&id) else {
                return;
            };
            transfer.done = Some(send);
            (
                transfer.origin.clone(),
                state.budget.clone(),
                state.path.clone(),
                state.notices.clone(),
            )
        };
        if let Some(reason) = self.limit(id) {
            self.cancel(id, reason, runtime);
        }
        let ready = cx.global::<super::model::BrowserState>().publisher.ready();
        let state = self.clone();
        let runtime = Rc::downgrade(&cx.global::<DownloadsRuntime>().0);
        cx.spawn(async move |cx| {
            let published = ready.await.unwrap_or(false);
            let task_origin = origin.clone();
            let task = cx.update(|cx| {
                Jobs::run(cx, move |client| async move {
                    if !published {
                        return Err("download_workspace_unavailable");
                    }
                    transfer(&client, &task_origin, name, budget, path, notices, receive).await
                })
            });
            let result = task.await.unwrap_or(Err("download_workspace_unavailable"));
            if result.is_err() {
                cx.update(|_| {
                    if let Some(runtime) = runtime.upgrade() {
                        runtime.cancel_download(origin.page, id);
                    }
                });
            }
            let stage = origin.stage.clone();
            cx.background_executor()
                .spawn(async move {
                    let _ = fs::remove_file(stage);
                })
                .await;
            cx.update(|cx| {
                let cancelled = state
                    .0
                    .borrow_mut()
                    .active
                    .remove(&id)
                    .is_none_or(|t| t.reason.is_some());
                if !cancelled {
                    let event = match result {
                        Ok(event) => event,
                        Err(reason) => failure(reason),
                    };
                    state.notify(&origin, event, cx);
                }
            });
        })
        .detach();
    }
    fn notify(&self, origin: &Origin, mut event: Value, cx: &mut App) {
        event["tab"] = json!(origin.tab.0.as_ref());
        event["epoch"] = json!(origin.epoch);
        self.0
            .borrow_mut()
            .events
            .entry(origin.owner.clone())
            .or_default()
            .push(event.clone());
        let Some(session) = origin.owner.strip_prefix("conversation:") else {
            return;
        };
        if super::area::title(session, cx).is_none() {
            return;
        }
        let copy = crate::ui::i18n::browser::BrowserStrings::get(cx);
        let completed = event["type"] == "download_completed";
        let message = if completed {
            copy.download_saved
        } else {
            match event["reason"].as_str() {
                Some("download_file_limit") => copy.download_file_limit,
                Some("download_session_limit") => copy.download_session_limit,
                _ => copy.download_failed,
            }
        };
        use butler_ds::ui::toast::{self, Toast};
        toast::show(
            cx,
            if completed {
                Toast::message(message)
            } else {
                Toast::error(message)
            },
        );
        if completed && let Some(refresh) = cx.try_global::<Refresh>().cloned() {
            (refresh.0)(session, cx);
        }
    }
    #[cfg(feature = "shots")]
    pub(crate) fn events(&self) -> HashMap<String, Vec<Value>> {
        self.0.borrow().events.clone()
    }
}
type RefreshView = Rc<dyn Fn(&str, &mut App)>;
#[derive(Clone)]
pub(crate) struct Refresh(pub(crate) RefreshView);
impl Global for Refresh {}
pub(super) struct DownloadsRuntime(pub(super) Rc<OsrRuntime>);
impl Global for DownloadsRuntime {}
