//! CEF pages share the shell's UI thread; callbacks enter through channels.
mod config;
mod devtools;
mod ime;
mod input;
mod surface;

use super::engine::{PageChange, PageCommand, PageEngine, PageEvent, Profile, TabId};
use super::page_dialog::{DialogAnswer, DialogKind, EngineChild, PageDialog};
use super::popup_policy::{PopupGate, policy};
use butler_cef_host::osr::{
    OsrAnswer, OsrDialogKind, OsrEvent, OsrProfile, OsrRuntime, OsrSink, PopupBlock,
};
use futures::{
    StreamExt as _,
    channel::mpsc,
    future::{Either, select},
};
use gpui::BorrowAppContext as _;
use gpui::{AnyElement, App, Window};
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    rc::Rc,
    sync::Arc,
    time::Instant,
};
use surface::PageState;

type Pages = Rc<RefCell<HashMap<u64, (TabId, Rc<RefCell<PageState>>)>>>;
struct Sink(mpsc::UnboundedSender<(u64, OsrEvent)>);
impl OsrSink for Sink {
    fn event(&self, page: u64, event: OsrEvent) {
        let _ = self.0.unbounded_send((page, event));
    }
}

pub(crate) struct CefEngine {
    runtime: Rc<OsrRuntime>,
    pages: Pages,
    ids: HashMap<TabId, u64>,
    shown: Rc<Cell<Option<u64>>>,
    next_id: Rc<Cell<u64>>,
    gate: Rc<RefCell<PopupGate>>,
    pending: HashMap<u64, OsrProfile>,
    downloads: super::downloads::Downloads,
}
impl CefEngine {
    pub(crate) fn start(
        events: mpsc::UnboundedSender<PageEvent>,
        adapter: Option<u64>,
        cx: &mut App,
    ) -> anyhow::Result<Self> {
        let (sink, receiver) = mpsc::unbounded();
        let (schedule, requests) = mpsc::unbounded();
        let gate = Rc::new(RefCell::new(PopupGate::default()));
        let downloads = super::downloads::Downloads::new(cx);
        let runtime = Rc::new(OsrRuntime::start(
            config::config(adapter, cx)?,
            Rc::new(Sink(sink)),
            Arc::new(move |delay| {
                let _ = schedule.unbounded_send(Instant::now() + delay);
            }),
            policy(gate.clone()),
            downloads.policy(),
        )?);
        cx.set_global(super::downloads::DownloadsRuntime(runtime.clone()));
        let pages = Pages::default();
        let shown = Rc::new(Cell::new(None));
        Self::receive(&pages, &gate, receiver, events, cx);
        Self::schedule(&runtime, requests, cx);
        Ok(Self {
            runtime,
            pages,
            ids: HashMap::new(),
            shown,
            next_id: gate.borrow().next_id.clone(),
            gate: gate.clone(),
            pending: HashMap::new(),
            downloads,
        })
    }
    fn materialize(&mut self, id: u64, url: &str) {
        let Some(profile) = self.pending.get(&id) else {
            return;
        };
        match self.runtime.open(id, url, (1, 1), 1., profile.clone()) {
            Ok(()) => {
                self.pending.remove(&id);
                self.runtime.set_visible(id, self.shown.get() == Some(id));
            }
            Err(error) => eprintln!("CEF open failed: {error}"),
        }
    }
    fn receive(
        pages: &Pages,
        gate: &Rc<RefCell<PopupGate>>,
        mut receiver: mpsc::UnboundedReceiver<(u64, OsrEvent)>,
        events: mpsc::UnboundedSender<PageEvent>,
        cx: &mut App,
    ) {
        let pages = Rc::downgrade(pages);
        let gate = gate.clone();
        cx.spawn(async move |cx| {
            while let Some((id, event)) = receiver.next().await {
                let Some(pages) = pages.upgrade() else {
                    break;
                };
                if cx.update(|cx| {
                    let downloads = cx.global::<super::downloads::Downloads>().clone();
                    let runtime = cx.global::<super::downloads::DownloadsRuntime>().0.clone();
                    downloads.event(&event, &runtime, cx)
                }) {
                    continue;
                }
                let Some((tab, state)) = pages.borrow().get(&id).cloned() else {
                    continue;
                };
                if let OsrEvent::Url(url) = &event
                    && let Some(page) = gate.borrow_mut().pages.get_mut(&id)
                {
                    page.url.clone_from(url);
                }
                if devtools::receive(&event, &mut state.borrow_mut()) {
                    continue;
                }
                // Opening a window can render the opener synchronously. Release its state first.
                let change = change(event, &mut state.borrow_mut());
                if let Some(change) = change {
                    let event = PageEvent { page: tab, change };
                    if matches!(event.change, PageChange::PopupOpened { .. }) {
                        // Bind the child's TabId before reading its first title/frame event.
                        cx.update(|cx| {
                            cx.update_global::<super::model::BrowserState, _>(|model, cx| {
                                model.apply(event, cx);
                            });
                            super::popup_window::sync(cx);
                            cx.refresh_windows();
                        });
                    } else {
                        let _ = events.unbounded_send(event);
                    }
                } else {
                    cx.update(App::refresh_windows);
                }
            }
        })
        .detach();
    }
    fn schedule(
        runtime: &Rc<OsrRuntime>,
        mut requests: mpsc::UnboundedReceiver<Instant>,
        cx: &mut App,
    ) {
        let runtime = Rc::downgrade(runtime);
        cx.spawn(async move |cx| {
            while let Some(mut deadline) = requests.next().await {
                loop {
                    let timer = butler_ds::ui::motion::sleep(
                        cx.background_executor(),
                        deadline.saturating_duration_since(Instant::now()),
                    );
                    match select(Box::pin(timer), Box::pin(requests.next())).await {
                        Either::Left(_) => {
                            let Some(runtime) = runtime.upgrade() else {
                                return;
                            };
                            cx.update(|_| runtime.pump());
                            break;
                        }
                        Either::Right((Some(next), _)) => deadline = deadline.min(next),
                        Either::Right((None, _)) => return,
                    }
                }
            }
        })
        .detach();
    }
}
/// Windows CEF differs in its staged layout, key codes and wheel units (macOS otherwise).
fn windows() -> bool {
    butler_platform::launcher::node_platform() == "win32"
}
fn change(event: OsrEvent, state: &mut PageState) -> Option<PageChange> {
    Some(match event {
        OsrEvent::Url(url) => PageChange::Url(if url == "about:blank" {
            String::new()
        } else {
            url
        }),
        OsrEvent::Title(title) => PageChange::Title(title),
        OsrEvent::Favicon(url) => PageChange::Favicon(url),
        OsrEvent::Loading(loading) => PageChange::Loading(loading),
        OsrEvent::History {
            can_back,
            can_forward,
        } => PageChange::History {
            can_back,
            can_forward,
        },
        OsrEvent::PopupNewTab { url } => PageChange::PopupNewTab(url),
        OsrEvent::PopupBlocked { url, reason } => PageChange::PopupBlocked {
            url,
            reason: match reason {
                PopupBlock::NoGesture => "no_gesture",
                PopupBlock::TabBudget => "tab_budget_exhausted",
            },
        },
        OsrEvent::PopupOpened { child, url } => PageChange::PopupOpened {
            child: EngineChild(child),
            url,
        },
        OsrEvent::CloseRequested => PageChange::CloseRequested,
        OsrEvent::Dialog(dialog) => PageChange::Dialog(PageDialog {
            id: dialog.id,
            kind: match dialog.kind {
                OsrDialogKind::Alert => DialogKind::Alert,
                OsrDialogKind::Confirm => DialogKind::Confirm,
                OsrDialogKind::Prompt => DialogKind::Prompt,
                OsrDialogKind::BeforeUnload => DialogKind::BeforeUnload,
                OsrDialogKind::Auth => DialogKind::Auth,
                OsrDialogKind::File => DialogKind::File,
            },
            message: dialog.message,
            default_prompt: dialog.default_prompt,
            origin: dialog.origin,
            accept_types: dialog.accept_types,
            multiple: dialog.multiple,
        }),
        OsrEvent::DownloadStarted { .. }
        | OsrEvent::DownloadProgress { .. }
        | OsrEvent::DownloadDone { .. }
        | OsrEvent::Frame
        | OsrEvent::DevToolsRaw { .. }
        | OsrEvent::DevTools { .. } => return None,
        OsrEvent::Crashed => PageChange::Crashed,
        OsrEvent::DevToolsEvent {
            method,
            params_json,
        } => PageChange::DevToolsEvent {
            method,
            params: serde_json::from_str(&params_json).unwrap_or_default(),
        },
        OsrEvent::Cursor(cursor) => {
            state.cursor = cursor;
            return None;
        }
        OsrEvent::ImeBounds(bounds) => {
            state.ime_bounds = bounds;
            return None;
        }
    })
}
impl PageEngine for CefEngine {
    fn supports_devtools(&self) -> bool {
        true
    }
    fn devtools(
        &self,
        page: &TabId,
        method: &str,
        params: &serde_json::Value,
    ) -> super::engine::DevToolsReply {
        devtools::send(self, page, method, params)
    }
    fn enabled(&self) -> bool {
        true
    }
    fn open(&mut self, page: &TabId, url: &str, profile: Profile, owner: &str) {
        let id = self.next_id.get() + 1;
        self.next_id.set(id);
        self.gate
            .borrow_mut()
            .insert(id, owner.to_owned(), url.to_owned());
        self.ids.insert(page.clone(), id);
        self.downloads.page(id, page, owner, 1);
        self.pages.borrow_mut().insert(
            id,
            (
                page.clone(),
                Rc::new(RefCell::new(PageState {
                    tab: Some(page.clone()),
                    last_input: self.gate.borrow().pages[&id].last_input.clone(),
                    ..PageState::default()
                })),
            ),
        );
        self.pending.insert(
            id,
            match profile {
                Profile::SignedIn => OsrProfile::SignedIn,
                Profile::SignedOut => OsrProfile::SignedOut(owner.to_owned()),
            },
        );
        if !url.is_empty() {
            self.materialize(id, url);
        }
    }

    fn adopt(&mut self, page: &TabId, child: EngineChild) {
        self.ids.insert(page.clone(), child.0);
        if let Some(source) = self.gate.borrow().pages.get(&child.0) {
            self.downloads.page(child.0, page, &source.owner_key, 1);
        }
        let input = self
            .gate
            .borrow()
            .pages
            .get(&child.0)
            .map(|p| p.last_input.clone())
            .unwrap_or_default();
        self.pages.borrow_mut().insert(
            child.0,
            (
                page.clone(),
                Rc::new(RefCell::new(PageState {
                    tab: Some(page.clone()),
                    last_input: input,
                    ..PageState::default()
                })),
            ),
        );
    }
    fn allow_popup(&mut self, page: &TabId, url: &str) {
        let Some(&id) = self.ids.get(page) else {
            return;
        };
        if let Some(source) = self.gate.borrow_mut().pages.get_mut(&id) {
            source.allowance = Some(super::popups::site(&source.url));
        }
        if let Ok(url) = serde_json::to_string(url) {
            self.runtime
                .eval(id, &format!("window.open({url}, '_blank')"));
        }
    }
    fn answer_dialog(&mut self, page: &TabId, dialog: u64, answer: DialogAnswer) {
        if let Some(&id) = self.ids.get(page) {
            self.runtime.answer_dialog(
                id,
                dialog,
                OsrAnswer {
                    accept: answer.accept,
                    text: answer.text,
                    username: answer.username,
                    password: answer.password,
                    files: answer.files,
                },
            );
        }
    }
    fn change_owner(&mut self, page: &TabId, owner: &str) {
        let Some(&id) = self.ids.get(page) else {
            return;
        };
        self.downloads.cancel_page(id, &self.runtime);
        let epoch = self.downloads.next_epoch(id);
        self.downloads.page(id, page, owner, epoch);
        let mut gate = self.gate.borrow_mut();
        if let Some(source) = gate.pages.get_mut(&id) {
            let old = std::mem::replace(&mut source.owner_key, owner.to_owned());
            source.allowance = None;
            if let Some(count) = gate.owners.get_mut(&old) {
                *count -= 1;
            }
            *gate.owners.entry(owner.to_owned()).or_default() += 1;
        }
        self.runtime.cancel_dialogs(id);
    }
    fn command(&mut self, page: &TabId, command: PageCommand) {
        let Some(&id) = self.ids.get(page) else {
            return;
        };
        match command {
            PageCommand::Load(url) => {
                if self.pending.contains_key(&id) {
                    self.materialize(id, &url);
                } else {
                    self.runtime.navigate(id, &url);
                }
            }
            PageCommand::Back => self.runtime.back(id),
            PageCommand::Forward => self.runtime.forward(id),
            PageCommand::Reload => self.runtime.reload(id),
            PageCommand::Stop => self.runtime.stop(id),
        }
    }
    fn resize(&mut self, page: &TabId, size: gpui::Size<gpui::Pixels>, scale: f32) {
        let Some(&id) = self.ids.get(page) else {
            return;
        };
        let pages = self.pages.borrow();
        let Some((_, state)) = pages.get(&id) else {
            return;
        };
        let mut state = state.borrow_mut();
        let geometry = (size, scale);
        if state.geometry == Some(geometry) {
            return;
        }
        state.geometry = Some(geometry);
        self.runtime.resize(
            id,
            (input::dimension(size.width), input::dimension(size.height)),
            scale,
        );
    }
    fn show(&mut self, page: Option<&TabId>) {
        let next = page.and_then(|page| self.ids.get(page)).copied();
        let old = self.shown.replace(next);
        if old == next {
            return;
        }
        if let Some(old) = old {
            self.runtime.set_visible(old, false);
        }
        if let Some(next) = next {
            self.runtime.set_visible(next, true);
        }
    }
    fn close(&mut self, page: &TabId) {
        if let Some(id) = self.ids.remove(page) {
            self.downloads.cancel_page(id, &self.runtime);
            self.downloads.remove_page(id);
            self.pending.remove(&id);
            self.gate.borrow_mut().remove(id);
            self.runtime.close(id);
            self.pages.borrow_mut().remove(&id);
            if self.shown.get() == Some(id) {
                self.shown.set(None);
            }
        }
    }
    fn frame_size(&self, page: &TabId) -> Option<(usize, usize)> {
        let frame = self.runtime.frame(*self.ids.get(page)?)?;
        Some((frame.get_width(), frame.get_height()))
    }
    fn surface(&self, page: &TabId, window: &mut Window, cx: &mut App) -> Option<AnyElement> {
        let id = *self.ids.get(page)?;
        if self.pending.contains_key(&id) {
            return None;
        }
        let state = self.pages.borrow().get(&id)?.1.clone();
        Some(surface::element(id, &self.runtime, state, window, cx))
    }
}
