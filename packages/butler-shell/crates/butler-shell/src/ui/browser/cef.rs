//! CEF pages share the shell's UI thread; callbacks enter through channels.
mod config;
mod ime;
mod input;
mod surface;

use super::engine::{PageChange, PageCommand, PageEngine, PageEvent, TabId};
use butler_cef_host::osr::{OsrEvent, OsrRuntime, OsrSink};
use futures::{
    StreamExt as _,
    channel::mpsc,
    future::{Either, select},
};
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
    next_id: u64,
}
impl CefEngine {
    pub(crate) fn start(
        events: mpsc::UnboundedSender<PageEvent>,
        cx: &mut App,
    ) -> anyhow::Result<Self> {
        let (sink, receiver) = mpsc::unbounded();
        let (schedule, requests) = mpsc::unbounded();
        let runtime = Rc::new(OsrRuntime::start(
            config::config(cx)?,
            Rc::new(Sink(sink)),
            Arc::new(move |delay| {
                let _ = schedule.unbounded_send(Instant::now() + delay);
            }),
        )?);
        let pages = Pages::default();
        let shown = Rc::new(Cell::new(None));
        Self::receive(&pages, shown.clone(), receiver, events, cx);
        Self::schedule(&runtime, requests, cx);
        Ok(Self {
            runtime,
            pages,
            ids: HashMap::new(),
            shown,
            next_id: 0,
        })
    }
    fn receive(
        pages: &Pages,
        shown: Rc<Cell<Option<u64>>>,
        mut receiver: mpsc::UnboundedReceiver<(u64, OsrEvent)>,
        events: mpsc::UnboundedSender<PageEvent>,
        cx: &mut App,
    ) {
        let pages = Rc::downgrade(pages);
        cx.spawn(async move |cx| {
            while let Some((id, event)) = receiver.next().await {
                let Some(pages) = pages.upgrade() else {
                    break;
                };
                let Some((tab, state)) = pages.borrow().get(&id).cloned() else {
                    continue;
                };
                if let Some(change) = change(event, &mut state.borrow_mut()) {
                    let _ = events.unbounded_send(PageEvent { page: tab, change });
                } else if shown.get() == Some(id) {
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
        OsrEvent::Crashed => PageChange::Crashed,
        OsrEvent::Frame => return None,
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
    fn enabled(&self) -> bool {
        true
    }
    fn open(&mut self, page: &TabId, url: &str) {
        self.next_id += 1;
        let id = self.next_id;
        self.ids.insert(page.clone(), id);
        self.pages.borrow_mut().insert(
            id,
            (page.clone(), Rc::new(RefCell::new(PageState::default()))),
        );
        if let Err(error) = self.runtime.open(
            id,
            if url.is_empty() { "about:blank" } else { url },
            (1, 1),
            1.,
        ) {
            eprintln!("CEF open failed: {error}");
        }
        self.runtime.set_visible(id, false);
    }
    fn command(&mut self, page: &TabId, command: PageCommand) {
        let Some(&id) = self.ids.get(page) else {
            return;
        };
        match command {
            PageCommand::Load(url) => self.runtime.navigate(id, &url),
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
        let state = self.pages.borrow().get(&id)?.1.clone();
        Some(surface::element(id, &self.runtime, state, window, cx))
    }
}
