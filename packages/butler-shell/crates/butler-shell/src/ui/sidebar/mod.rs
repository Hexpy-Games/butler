//! The sidebar (SidebarShell, NavRow, NavSectionHeading, CollapsibleNavGroup, Tabs) with the
//! product composition of components/space/SpaceSidebar.tsx, over the chats the shell has
//! loaded.
mod list;
mod row;

use std::collections::HashMap;

use gpui::{AnyElement, Context, SharedString, WindowControlArea, div, prelude::*, px};

use crate::ui::Icon;
use crate::ui::shell::Shell;
use crate::ui::source::ChatRef;
use row::RowSpec;

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
}

impl SidebarState {
    pub(crate) fn new() -> Self {
        Self {
            tab: Tab::All,
            folded: HashMap::new(),
            space_limit: HashMap::new(),
            root_limit: 30,
        }
    }
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
            let general = RowSpec::new("general", Some(Icon::GeneralChat), s.general)
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
            ..RowSpec::new("p-new", Some(Icon::PencilLine), s.new_chat)
        };
        primary = primary.child(self.nav_row(new.disabled(new_disabled), Click::Chat(None), cx));
        for (key, glyph, label) in [
            ("p-search", Icon::Search, s.search),
            ("p-sched", Icon::Clock3, s.schedules),
            ("p-library", Icon::Library, s.library),
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
                    Some(Icon::MessageSquare),
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

    pub(crate) fn render_sidebar(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let header = self.primary(cx);
        let sticky = self.browse_header(cx);
        let rows = self.chat_rows(cx);
        let s = self.theme.strings;
        let settings = self.nav_row(
            RowSpec::new("settings", Some(Icon::Settings), s.settings)
                .disabled(Some(s.not_yet.into())),
            Click::Chat(None),
            cx,
        );
        crate::ui::widgets::anchor(div(), "sidebar")
            .size_full()
            .child(
                butler_ds::ui::blocks::sidebar_shell::SidebarShell::new("sidebar-shell")
                    .titlebar(div().w_full().window_control_area(WindowControlArea::Drag))
                    .scroll_header(header)
                    .sticky_header(sticky)
                    .child(div().flex().flex_col().gap(px(4.)).children(rows))
                    .footer(settings),
            )
            .into_any_element()
    }

    fn chat_rows(&mut self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        match self.sidebar.tab {
            Tab::All => self.tree(cx),
            Tab::Recent => self.flat(false, cx),
            Tab::Running => self.flat(true, cx),
        }
    }
}
