//! The log list (`LogsSettings.tsx` `LogList`): 기록 (the level), 목록 (the entries), the storage
//! section of U11 and the context estimates, in that order.
//!
//! CARVE-OUT(G-scroll): React holds live rows behind "N new lines" while the list's top is out
//! of view (`useListTop`, `IntersectionObserver`) and scrolls the row left open back into view
//! after a trace (`useOpenRowAnchor`). A settings page has no scroll position or scroll-to, so
//! live rows join the list at once and the open row stays open.
mod api;
mod config;
mod copy;
mod filters;
mod format;
mod http;
mod live;
mod records;
mod rows;
mod usage;
mod viewer;

use std::collections::HashMap;
use std::rc::Rc;

use butler_ds::ui::blocks::settings_section::SettingsPage;
use butler_ds::ui::toast::{self, Toast, ToastId};
use gpui::{
    App, AppContext as _, Context, Entity, IntoElement, Render, Subscription, Task, Window,
};

use self::api::{Filter, LogConfig};
use self::live::Live;
use self::records::RecordList;
use super::trace::{LogStorage, LogStorageEvent, TraceTarget};
use crate::ui::settings::SectionCtx;
use crate::ui::settings::state::Load;

/// Opens one trace as the section's subpage (`openLogTrace`).
pub(super) type OpenTrace = Rc<dyn Fn(TraceTarget, &mut Window, &mut App)>;

/// `stores/logListStore.ts`: what outlives the list while a trace is open, so 로그 returns to
/// the same list. The rows are read again.
#[derive(Clone, Default)]
pub(super) struct ViewState {
    filter: Filter,
    live: bool,
    /// The open row, by record key.
    open_key: Option<String>,
}

/// The 기록 section's own state.
#[derive(Default)]
struct Level {
    failed: bool,
    saving: bool,
    categories_open: bool,
}

pub(super) struct LogList {
    ctx: SectionCtx,
    open_trace: OpenTrace,
    storage: Entity<LogStorage>,
    config: Option<LogConfig>,
    level: Level,
    /// Ticks while a full-logging lease runs.
    lease: Option<Task<()>>,
    filter: Filter,
    search: Option<Task<()>>,
    live: bool,
    live_conn: Option<Live>,
    open_key: Option<String>,
    rows: RecordList,
    paging: bool,
    /// Bumped by each read of the first page; an older answer is dropped.
    generation: u64,
    /// Stored bodies by reference.
    bodies: HashMap<String, Load<String>>,
    usage: Load<usage::Sections>,
    level_toast: Option<ToastId>,
    live_toast: Option<ToastId>,
    more_toast: Option<ToastId>,
    _subscriptions: Vec<Subscription>,
}

impl LogList {
    pub(super) fn new(
        ctx: SectionCtx,
        open_trace: OpenTrace,
        view: ViewState,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let storage = cx.new(|cx| LogStorage::new(ctx.clone(), window, cx));
        let subscriptions = vec![
            cx.observe(&ctx.state, |_, _, cx| cx.notify()),
            cx.observe(&storage, |_, _, cx| cx.notify()),
            // `onCleared`: deleting all logs reads the entries again.
            cx.subscribe(&storage, |this, _, _: &LogStorageEvent, cx| {
                this.reload_rows(cx);
            }),
        ];
        let mut list = Self {
            ctx,
            open_trace,
            storage,
            config: None,
            level: Level::default(),
            lease: None,
            filter: view.filter,
            search: None,
            live: view.live,
            live_conn: None,
            open_key: view.open_key,
            rows: RecordList::new(),
            paging: false,
            generation: 0,
            bodies: HashMap::new(),
            usage: Load::Loading,
            level_toast: None,
            live_toast: None,
            more_toast: None,
            _subscriptions: subscriptions,
        };
        list.load_config(cx);
        list.reload_rows(cx);
        Self::load_usage(cx);
        if list.live {
            list.live_conn = Some(live::connect(cx));
        }
        list
    }

    pub(super) fn view_state(&self) -> ViewState {
        ViewState {
            filter: self.filter.clone(),
            live: self.live,
            open_key: self.open_key.clone(),
        }
    }
}

impl Render for LogList {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let copy = copy::get(cx);
        let storage = self
            .storage
            .update(cx, |storage, cx| storage.section(window, cx));
        SettingsPage::new()
            .labels(SectionCtx::labels(cx))
            .section(self.level_section(copy, cx))
            .section(self.viewer_section(copy, cx))
            .section(storage)
            .section(self.usage_section(copy))
    }
}

/// Shows `toast` as the one toast of `slot`, in place of the last one (`notify*` with an id).
fn show(slot: &mut Option<ToastId>, next: Toast, cx: &mut App) {
    let next = match *slot {
        Some(id) => next.id(id),
        None => next,
    };
    *slot = Some(toast::show(cx, next));
}
