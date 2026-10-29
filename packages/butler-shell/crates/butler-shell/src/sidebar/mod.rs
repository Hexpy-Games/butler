//! The sidebar (SidebarShell, NavRow, NavSectionHeading, CollapsibleNavGroup, Tabs) with the
//! product composition of components/space/SpaceSidebar.tsx, over the chats the shell has
//! loaded.
mod list;
mod row;

use std::cell::Cell;
use std::collections::HashMap;
use std::rc::Rc;

use gpui::{
    AnyElement, Bounds, Context, Pixels, ScrollHandle, SharedString, WindowControlArea, canvas,
    div, prelude::*, px,
};

use crate::cliptop::clip_top;
use crate::shell::Shell;
use crate::smooth_scroll::SmoothScroll;
use crate::source::ChatId;
pub(crate) use row::NOT_YET;
use row::RowSpec;

pub(crate) const SIDEBAR_W: f32 = 304.;
/// The collapsed track keeps the cards' 8px window inset (7px + the workspace's 1px frame).
pub(crate) const TRACK_MIN: f32 = 7.;
/// The fade (14px) plus the focus-ring room (3px) below the scroll top where the browse header
/// sticks.
const STICK_AT: f32 = 17.;

/// Bounds a canvas records each frame.
type BoundsCell = Rc<Cell<Option<Bounds<Pixels>>>>;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Tab {
    All,
    Recent,
    Running,
}

#[derive(Clone)]
pub(super) enum Click {
    Chat(Option<ChatId>),
    Space(SharedString),
    More(Option<SharedString>),
    Tab(Tab),
}

pub(crate) struct SidebarState {
    tab: Tab,
    /// Spaces the owner folded (all start open).
    folded: HashMap<SharedString, bool>,
    /// Rows shown per space, and at the root.
    space_limit: HashMap<SharedString, usize>,
    root_limit: usize,
    scroll: ScrollHandle,
    smooth: SmoothScroll,
    /// The scroll viewport and the in-flow browse header, from the last frame.
    probe: (BoundsCell, BoundsCell),
}

impl SidebarState {
    pub(crate) fn new() -> Self {
        let scroll = ScrollHandle::new();
        Self {
            tab: Tab::All,
            folded: HashMap::new(),
            space_limit: HashMap::new(),
            root_limit: 30,
            smooth: SmoothScroll::handle(scroll.clone()),
            scroll,
            probe: (Rc::new(Cell::new(None)), Rc::new(Cell::new(None))),
        }
    }
}

fn probe(cell: BoundsCell) -> impl IntoElement {
    canvas(move |b, _, _| cell.set(Some(b)), |_, (), _, _| {})
        .absolute()
        .top_0()
        .left_0()
        .size_full()
}

impl Shell {
    fn on_row(&mut self, click: &Click, window: &mut gpui::Window, cx: &mut Context<Self>) {
        let s = &mut self.sidebar;
        match click {
            Click::Chat(chat) => self.open_chat(chat.clone(), window, cx),
            Click::Space(id) => {
                let folded = s.folded.entry(id.clone()).or_insert(false);
                *folded = !*folded;
            }
            Click::More(Some(id)) => *s.space_limit.entry(id.clone()).or_insert(5) += 5,
            Click::More(None) => {
                s.root_limit += 30;
                self.load_more_chats(cx);
            }
            Click::Tab(t) => s.tab = *t,
        }
        cx.notify();
    }

    /// The browse header (SpaceBrowseHeader): tabs, the general row, the section heading.
    fn browse_header(&mut self, cx: &mut Context<Self>) -> gpui::Div {
        let tabs = self.tabs(cx);
        let tab = self.sidebar.tab;
        let title = match tab {
            Tab::All => "스페이스",
            Tab::Recent => "최신",
            Tab::Running => "진행중",
        };
        let heading = self.heading(title, true, cx);
        let mut top = div().flex().flex_col().gap(px(12.)).child(tabs);
        if tab == Tab::All {
            let general =
                RowSpec::new("general", Some("general"), "대화").disabled(Some(NOT_YET.into()));
            top = top.child(self.nav_row(general, Click::Chat(None), cx));
        }
        let gap = if tab == Tab::All { 8. } else { 16. };
        div()
            .flex()
            .flex_col()
            .gap(px(gap))
            .pb(px(5.))
            .child(top)
            .child(heading)
    }

    /// New chat, search, schedules and the drawer, then the favourites.
    fn primary(&mut self, cx: &mut Context<Self>) -> gpui::Div {
        let new_disabled = self.new_chat_disabled();
        let mut primary = div().flex().flex_col().gap(px(4.));
        let new = RowSpec {
            active: self.chat_selected().is_none() && new_disabled.is_none(),
            ..RowSpec::new("p-new", Some("pencil"), "새 대화")
        };
        primary = primary.child(self.nav_row(new.disabled(new_disabled), Click::Chat(None), cx));
        for (key, glyph, label) in [
            ("p-search", "search", "검색"),
            ("p-sched", "clock", "예약 작업"),
            ("p-library", "library", "서랍"),
        ] {
            let spec = RowSpec::new(key, Some(glyph), label).disabled(Some(NOT_YET.into()));
            primary = primary.child(self.nav_row(spec, Click::Chat(None), cx));
        }
        let pinned: Vec<_> = self.chats.iter().filter(|c| c.pinned).cloned().collect();
        let mut favorites = div().flex().flex_col().gap(px(4.));
        for chat in pinned {
            let spec = RowSpec {
                active: self.chat_selected() == Some(&chat.id),
                ..RowSpec::new(
                    format!("fav-{}", chat.id.0),
                    Some("message"),
                    chat.title.clone(),
                )
            };
            favorites = favorites.child(self.nav_row(spec, Click::Chat(Some(chat.id)), cx));
        }
        let fav_heading = self.heading("즐겨찾기", false, cx);
        div()
            .flex()
            .flex_col()
            .gap(px(24.))
            .pb(px(24.))
            .child(primary)
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .child(fav_heading)
                    .child(favorites),
            )
    }

    pub(crate) fn render_sidebar(&mut self, cx: &mut Context<Self>) -> gpui::Div {
        let scroll_header = self.primary(cx);
        // position: sticky at STICK_AT below the scroll top.
        let (viewport, natural) = (self.sidebar.probe.0.get(), self.sidebar.probe.1.get());
        let stuck =
            matches!((viewport, natural), (Some(v), Some(n)) if n.top() <= v.top() + px(STICK_AT));
        let sticky_h = natural.map(|n| n.size.height).unwrap_or_default();
        let clip_y = viewport
            .filter(|_| stuck)
            .map(|v| v.top() + px(STICK_AT) + sticky_h);
        let sticky = div()
            .relative()
            .child(probe(self.sidebar.probe.1.clone()))
            .child(self.browse_header(cx))
            .when(stuck, |d| d.opacity(0.));
        let overlay = stuck.then(|| {
            div()
                .id("sticky-overlay")
                .absolute()
                .top_0()
                .left_0()
                .right_0()
                .pt(px(STICK_AT))
                .occlude()
                .child(self.browse_header(cx))
        });
        let rows = self.chat_rows(cx);
        let settings = self.nav_row(
            RowSpec::new("settings", Some("settings"), "설정").disabled(Some(NOT_YET.into())),
            Click::Chat(None),
            cx,
        );
        let content = div()
            .flex()
            .flex_col()
            .py(px(3.))
            .child(scroll_header)
            .child(sticky)
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(4.))
                    .pt(px(3.))
                    .children(rows),
            );
        let scroller = div()
            .id("sidebar-scroll")
            .size_full()
            .overflow_y_scroll()
            .track_scroll(&self.sidebar.scroll)
            .child(clip_top(content, clip_y));
        div()
            .w(px(SIDEBAR_W))
            .h_full()
            .flex()
            .flex_col()
            .px(px(14.))
            .pb(px(16.))
            .child(
                div()
                    .h(px(48.))
                    .flex_none()
                    .w_full()
                    .window_control_area(WindowControlArea::Drag),
            )
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .relative()
                    .child(probe(self.sidebar.probe.0.clone()))
                    .child(self.sidebar.smooth.layer())
                    .child(scroller)
                    .children(overlay),
            )
            .child(div().pt(px(10.)).flex_none().child(settings))
    }

    fn chat_rows(&mut self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        match self.sidebar.tab {
            Tab::All => self.tree(cx),
            Tab::Recent => self.flat(false, cx),
            Tab::Running => self.flat(true, cx),
        }
    }
}
