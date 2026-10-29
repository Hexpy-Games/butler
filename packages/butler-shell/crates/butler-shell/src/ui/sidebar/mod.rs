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

use crate::ui::cliptop::clip_top;
use crate::ui::shell::Shell;
use crate::ui::smooth_scroll::SmoothScroll;
use crate::ui::source::ChatRef;
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
    Chat(Option<ChatRef>),
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
        let state = &mut self.sidebar;
        match click {
            Click::Chat(chat) => self.open_chat(chat.clone(), window, cx),
            Click::Space(id) => {
                let folded = state.folded.entry(id.clone()).or_insert(false);
                *folded = !*folded;
            }
            Click::More(Some(id)) => *state.space_limit.entry(id.clone()).or_insert(5) += 5,
            Click::More(None) => {
                state.root_limit += 30;
                self.load_more_chats(cx);
            }
            Click::Tab(t) => state.tab = *t,
        }
        cx.notify();
    }

    /// The browse header (SpaceBrowseHeader): tabs, the general row, the section heading.
    fn browse_header(&mut self, cx: &mut Context<Self>) -> gpui::Div {
        let s = self.theme.strings;
        let tabs = self.tabs(cx);
        let tab = self.sidebar.tab;
        let title = match tab {
            Tab::All => s.space,
            Tab::Recent => s.recent,
            Tab::Running => s.running,
        };
        let heading = self.heading(title, true, cx);
        let mut top = div().flex().flex_col().gap(px(12.)).child(tabs);
        if tab == Tab::All {
            let general = RowSpec::new("general", Some("general"), s.general)
                .disabled(Some(s.not_yet.into()));
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
        let s = self.theme.strings;
        let new_disabled = self.disconnected();
        let mut primary = div().flex().flex_col().gap(px(4.));
        let new = RowSpec {
            active: self.store.selected().is_none() && new_disabled.is_none(),
            ..RowSpec::new("p-new", Some("pencil"), s.new_chat)
        };
        primary = primary.child(self.nav_row(new.disabled(new_disabled), Click::Chat(None), cx));
        for (key, glyph, label) in [
            ("p-search", "search", s.search),
            ("p-sched", "clock", s.schedules),
            ("p-library", "library", s.library),
        ] {
            let spec = RowSpec::new(key, Some(glyph), label).disabled(Some(s.not_yet.into()));
            primary = primary.child(self.nav_row(spec, Click::Chat(None), cx));
        }
        let pinned: Vec<_> = self
            .store
            .chats
            .iter()
            .filter(|c| c.pinned)
            .cloned()
            .collect();
        let mut favorites = div().flex().flex_col().gap(px(4.));
        for chat in pinned {
            let spec = RowSpec {
                active: self.store.selected() == Some(&chat.chat),
                ..RowSpec::new(
                    format!("fav-{}", chat.chat.chat.0),
                    Some("message"),
                    chat.title.clone(),
                )
            };
            favorites = favorites.child(self.nav_row(spec, Click::Chat(Some(chat.chat)), cx));
        }
        let fav_heading = self.heading(s.favorites, false, cx);
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
        let s = self.theme.strings;
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
            RowSpec::new("settings", Some("settings"), s.settings).disabled(Some(s.not_yet.into())),
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
