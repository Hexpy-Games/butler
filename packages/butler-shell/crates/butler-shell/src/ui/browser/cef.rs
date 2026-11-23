//! CEF pages share the shell's UI thread; callbacks enter through channels.
mod change;
mod config;
mod devtools;
mod ime;
mod input;
mod surface;

use super::engine::{
    PageChange, PageCommand, PageEngine, PageEvent, Profile, SiteDataReply, TabId,
};
use super::page_dialog::{DialogAnswer, EngineChild};
use super::popup_policy::{PopupGate, PopupSites, policy};
use butler_cef_host::osr::{OsrAnswer, OsrEvent, OsrProfile, OsrRuntime, OsrSink};
use futures::{
    StreamExt as _,
    channel::{mpsc, oneshot},
    future::{Either, select},
};
use gpui::{AnyElement, App, Window};
use gpui::{AppContext as _, BorrowAppContext as _};
use std::{
    cell::{Cell, RefCell},
    collections::{HashMap, HashSet},
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
    rate: Rc<Cell<u32>>,
    pages: Pages,
    ids: HashMap<TabId, u64>,
    shown: Rc<Cell<Option<u64>>>,
    awake: HashSet<u64>,
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
            rate: Rc::new(Cell::new(60)),
            pages,
            ids: HashMap::new(),
            shown,
            awake: HashSet::new(),
            next_id: gate.borrow().next_id.clone(),
            gate: gate.clone(),
            pending: HashMap::new(),
            downloads,
        })
    }
    /// The one place that decides a page's visibility: shown, or kept awake.
    fn visible(&self, id: u64) -> bool {
        self.shown.get() == Some(id) || self.awake.contains(&id)
    }
    fn materialize(&mut self, id: u64, url: &str) {
        let Some(profile) = self.pending.get(&id) else {
            return;
        };
        match self
            .runtime
            .open(id, url, (1, 1), 1., self.rate.get(), profile.clone())
        {
            Ok(()) => {
                self.pending.remove(&id);
                self.runtime.set_visible(id, self.visible(id));
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
                let redraw = matches!(event, OsrEvent::Frame | OsrEvent::Cursor(_));
                let change = change::change(event, &mut state.borrow_mut());
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
                } else if redraw {
                    state.borrow_mut().views.retain(|v| v.upgrade().is_some());
                    let views = state.borrow().views.clone();
                    cx.update(|cx| {
                        for view in views {
                            cx.notify(view.entity_id());
                        }
                    });
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
impl PageEngine for CefEngine {
    fn shutdown(&mut self) {
        self.runtime.shutdown();
    }
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
    fn devtools_raw(&self, page: &TabId, message: &[u8]) {
        if let Some(&id) = self.ids.get(page) {
            let _ = self.runtime.devtools_raw(id, message);
        }
    }
    fn devtools_raw_end(&self, page: &TabId) {
        if let Some(&id) = self.ids.get(page) {
            self.runtime.devtools_raw_end(id);
        }
    }
    fn keep_awake(&mut self, page: &TabId, awake: bool) {
        let Some(&id) = self.ids.get(page) else {
            return;
        };
        if awake {
            self.awake.insert(id);
        } else {
            self.awake.remove(&id);
        }
        if !self.pending.contains_key(&id) {
            self.runtime.set_visible(id, self.visible(id));
        }
    }
    fn set_hosted(&mut self, page: &TabId, hosted: bool) {
        if let Some(id) = self.ids.get(page)
            && let Some(source) = self.gate.borrow_mut().pages.get_mut(id)
        {
            source.hosted = hosted;
        }
    }
    fn set_popup_sites(&mut self, page: &TabId, sites: Vec<String>, hosts: Vec<String>) {
        if let Some(id) = self.ids.get(page)
            && let Some(source) = self.gate.borrow_mut().pages.get_mut(id)
        {
            source.popups = Rc::new(PopupSites { sites, hosts });
        }
    }
    fn enabled(&self) -> bool {
        true
    }
    fn open(&mut self, page: &TabId, url: &str, profile: Profile, owner: &str, partition: &str) {
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
                    rate: self.rate.clone(),
                    last_input: self.gate.borrow().pages[&id].last_input.clone(),
                    ..PageState::default()
                })),
            ),
        );
        self.pending.insert(
            id,
            match profile {
                Profile::SignedIn => OsrProfile::SignedIn,
                Profile::SignedOut => OsrProfile::SignedOut(partition.to_owned()),
            },
        );
        if !url.is_empty() {
            self.materialize(id, url);
        }
    }

    fn adopt(&mut self, page: &TabId, child: EngineChild) -> bool {
        self.ids.insert(page.clone(), child.0);
        let gate = self.gate.borrow();
        let source = gate.pages.get(&child.0);
        if let Some(source) = source {
            self.downloads.page(child.0, page, &source.owner_key, 1);
        }
        let input = source.map(|p| p.last_input.clone()).unwrap_or_default();
        let hosted = source.is_some_and(|p| p.hosted);
        drop(gate);
        self.pages.borrow_mut().insert(
            child.0,
            (
                page.clone(),
                Rc::new(RefCell::new(PageState {
                    tab: Some(page.clone()),
                    rate: self.rate.clone(),
                    last_input: input,
                    ..PageState::default()
                })),
            ),
        );
        hosted
    }
    fn release_loads(&mut self, page: &TabId) -> Option<String> {
        self.runtime.release_loads(*self.ids.get(page)?)
    }
    fn held_url(&self, page: &TabId) -> Option<String> {
        self.runtime.held_url(*self.ids.get(page)?)
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
            self.runtime.set_visible(old, self.visible(old));
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
            self.awake.remove(&id);
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
    fn thumbnail(&self, page: &TabId, window: &mut Window, cx: &mut App) -> Option<AnyElement> {
        let id = *self.ids.get(page)?;
        if self.pending.contains_key(&id) {
            return None;
        }
        let state = self.pages.borrow().get(&id)?.1.clone();
        Some(surface::thumbnail(id, &self.runtime, state, window, cx))
    }

    fn site_data(&self) -> bool {
        true
    }
    fn clear_site_data(&mut self, origins: &[String]) -> SiteDataReply {
        let (tx, rx) = oneshot::channel();
        self.runtime.clear_site_data(
            origins,
            Box::new(move |r| {
                let _ = tx.send(r.map_err(anyhow::Error::from));
            }),
        );
        rx
    }
    fn sign_out_site(&mut self, site: &str) -> SiteDataReply {
        let (tx, rx) = oneshot::channel();
        self.runtime.sign_out_site(
            site,
            Box::new(move |r| {
                let _ = tx.send(r.map_err(anyhow::Error::from));
            }),
        );
        rx
    }
}
