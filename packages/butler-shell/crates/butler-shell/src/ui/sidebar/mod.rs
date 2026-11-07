//! SpaceSidebar: DS screen assembly; navigation ownership lives in Store.
mod activity;
mod browse;
mod canon;
mod canon_state;
mod data;
mod dialogs;
mod drag;
mod footer;
mod gestures;
mod header;
mod menu;
mod notice;
mod projects;
mod row;
use crate::ui::shell::Shell;
use crate::ui::source::{ChatId, ChatRef, SessionId};
use crate::ui::store::navigation::SpaceRowData;
use butler_ds::ui::blocks::sidebar_shell::SidebarShell;
pub(crate) use drag::SpaceDragPayload;
use gpui::{AnyElement, Context, SharedString, Window, div, prelude::*};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Copy, PartialEq, Eq, Default)]
pub(crate) enum Tab {
    #[default]
    All,
    Recent,
    Running,
}
impl Tab {
    fn value(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::Recent => "recent",
            Self::Running => "running",
        }
    }
}
#[expect(
    clippy::struct_excessive_bools,
    reason = "independent hook state from SpaceSidebar and useWorkStatus"
)]
#[derive(Default)]
pub(crate) struct SidebarState {
    tab: Tab,
    collapsed: HashSet<String>,
    visible_count: usize,
    branch_counts: HashMap<String, usize>,
    reveal_path: Vec<String>,
    /// The row to scroll into view: `reveal_path[0]` until its row has painted.
    reveal_scroll: Option<String>,
    /// The sidebar scroller's handle, published by the shell each frame.
    scroll: butler_ds::ui::blocks::sidebar_shell::ScrollSlot,
    dialog: Option<dialogs::SpaceDialog>,
    dialog_serial: u64,
    fields: HashMap<
        SharedString,
        (
            gpui::Entity<gpui_elements::editable_text::EditableTextState>,
            gpui::Subscription,
        ),
    >,
    pending: bool,
    error: Option<String>,
    undo_token: Option<String>,
    undo_revision: Option<i64>,
    notice_token: Option<String>,
    notice_id: Option<butler_ds::ui::toast::ToastId>,
    menus: HashSet<String>,
    drag_source: Option<String>,
    drag_instance: Option<String>,
    root_drop_active: bool,
    long_press_key: Option<String>,
    long_press_origin: Option<gpui::Point<gpui::Pixels>>,
    long_press_task: Option<gpui::Task<()>>,
    long_press_fired: Option<String>,
    pub(crate) reference: Option<SpaceDragPayload>,
    pub(crate) new_chat_parent: Option<crate::ui::source::sidebar::DraftTarget>,
    update: Option<crate::ui::source::wire::UpdateProgressView>,
    update_in_flight: bool,
    pub(super) attended: bool,
    pub(super) window_handle: Option<gpui::AnyWindowHandle>,
    age_task: Option<gpui::Task<()>>,
    reading: HashSet<String>,
    general_ready: bool,
    general_loading: bool,
    general_busy: bool,
    work_in_flight: bool,
    work_scheduled: bool,
    work_dirty: bool,
    work_generation: u64,
    canon: HashMap<String, crate::ui::source::wire::CanonSidebar>,
    canon_loading: HashSet<String>,
    canon_visible: HashSet<String>,
    canon_previous: HashSet<String>,
    canon_generation: u64,
    canon_form: Option<canon::forms::CanonFormState>,
    canon_sessions: HashMap<String, Vec<crate::ui::source::wire::EpicCard>>,
}
impl SidebarState {
    pub(crate) fn new() -> Self {
        Self {
            visible_count: 30,
            ..Self::default()
        }
    }
    pub(crate) fn begin_snapshot(&mut self) {
        self.canon_generation += 1;
        self.canon_loading.clear();
        self.canon_visible.clear();
        self.canon_previous.clear();
        self.work_in_flight = false;
        self.work_scheduled = false;
        self.work_dirty = false;
        self.work_generation += 1;
        self.general_loading = false;
        self.general_ready = false;
    }
    pub(crate) fn connection_lost(&mut self) {
        self.begin_snapshot();
        self.reading.clear();
        self.update_in_flight = false;
        self.pending = false;
        self.work_in_flight = false;
        self.canon_loading.clear();
        self.set_dialog(None);
    }
    fn take_long_press(&mut self, key: &str) -> bool {
        if self.long_press_fired.as_deref() == Some(key) {
            self.long_press_fired = None;
            true
        } else {
            false
        }
    }
    fn cancel_long_press(&mut self) {
        self.long_press_key = None;
        self.long_press_origin = None;
        self.long_press_task = None;
    }
    fn toggle(&mut self, key: &str) {
        if !self.collapsed.remove(key) {
            self.collapsed.insert(key.to_owned());
        }
    }
    fn set_tab(&mut self, value: &str) {
        self.branch_counts.clear();
        self.menus.clear();
        let tab = match value {
            "recent" => Tab::Recent,
            "running" => Tab::Running,
            _ => Tab::All,
        };
        if self.tab != tab {
            self.work_generation += 1;
            self.work_in_flight = false;
            self.work_scheduled = false;
            self.work_dirty = false;
        }
        self.tab = tab;
    }
    fn set_dialog(&mut self, dialog: Option<dialogs::SpaceDialog>) {
        self.dialog_serial += 1;
        self.fields.clear();
        self.dialog = dialog;
        self.error = None;
    }
}
impl Shell {
    pub(crate) fn render_sidebar(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        self.space_sidebar(window, cx)
    }
    fn space_sidebar(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        self.sidebar.canon_previous = std::mem::take(&mut self.sidebar.canon_visible);
        if !cx.has_active_drag() {
            self.sidebar.drag_source = None;
            self.sidebar.drag_instance = None;
            self.sidebar.root_drop_active = false;
        }
        self.sidebar.window_handle = Some(window.window_handle());
        self.sidebar.attended = window.is_window_active();
        self.sync_minute_clock(cx);
        let header = self.space_header(cx);
        let browse = self.space_browse_header(window, cx);
        let rows = self.sidebar_roots();
        let reveal_index = rows
            .iter()
            .position(|r| self.sidebar.reveal_path.contains(&r.node.key))
            .map_or(0, |i| i + 1);
        let limit = self.sidebar.visible_count.max(reveal_index);
        let mut body = vec![self.space_row_list(
            "sidebar-tree-list",
            self.sidebar.tab.value(),
            rows.iter().take(limit).cloned().collect(),
            self.sidebar.tab != Tab::All,
            cx,
        )];
        if rows.len() > self.sidebar.visible_count {
            body.push(self.sidebar_session_load_more(
                None,
                rows.len() - self.sidebar.visible_count,
                self.sidebar.visible_count,
                cx,
            ));
        }
        if self.sidebar.tab == Tab::Running {
            body.push(self.space_work_status(cx));
        }
        let tree = self.space_drop_scope(body, window, cx);
        let footer = self.sidebar_footer(cx);
        crate::ui::widgets::anchor(div(), "sidebar")
            .size_full()
            .child(
                SidebarShell::new("sidebar-shell")
                    .titlebar(
                        div()
                            .w_full()
                            .window_control_area(gpui::WindowControlArea::Drag),
                    )
                    .scroll_header(header)
                    .sticky_header(browse)
                    .scroll_slot(self.sidebar.scroll.clone())
                    .child(Self::sidebar_sticky(window, cx).recorder())
                    .child(tree)
                    .footer(footer),
            )
            .into_any_element()
    }
    fn sidebar_roots(&self) -> Vec<SpaceRowData> {
        let model = &self.store.navigation;
        if self.sidebar.tab == Tab::All {
            return model.children(None);
        }
        let mut rows: Vec<_> = model
            .rows
            .values()
            .filter(|r| {
                r.session.as_ref().is_some_and(|s| {
                    self.sidebar.tab == Tab::Recent
                        || crate::ui::store::navigation::space_activity(s, false).is_some()
                })
            })
            .cloned()
            .collect();
        rows.sort_by(|a, b| {
            b.updated_at
                .cmp(&a.updated_at)
                .then(a.node.key.cmp(&b.node.key))
        });
        rows
    }
    fn open_sidebar_session(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.open_chat(
            Some(ChatRef {
                chat: ChatId(id.to_owned().into()),
                session: SessionId(id.to_owned().into()),
            }),
            window,
            cx,
        );
        self.mark_sidebar_read(id, cx);
    }
    pub(crate) fn reveal_sidebar(&mut self, id: &str, open_sidebar: bool) {
        self.reveal_node(&format!("s:{id}"), open_sidebar);
    }

    /// `useOrganization.reveal`: the node's ancestors expand on the All tab and it scrolls into view.
    pub(crate) fn reveal_node(&mut self, key: &str, open_sidebar: bool) {
        let nodes = self
            .store
            .navigation
            .view
            .as_ref()
            .map(|view| {
                view.space
                    .nodes
                    .iter()
                    .map(|node| (node.key.as_str(), node))
                    .collect::<HashMap<_, _>>()
            })
            .unwrap_or_default();
        let mut current = nodes.get(key).copied();
        let mut path = Vec::new();
        while let Some(node) = current {
            path.push(node.key.clone());
            current = node
                .parentKey
                .as_deref()
                .and_then(|key| nodes.get(key).copied());
        }
        if open_sidebar {
            self.sidebar_open = true;
        }
        if self.sidebar.tab != Tab::All {
            self.sidebar.set_tab("all");
        }
        for key in &path {
            self.sidebar.collapsed.remove(key);
        }
        self.sidebar.reveal_scroll = path.first().cloned();
        self.sidebar.reveal_path = path;
    }
    fn show_sidebar_session(&mut self, id: String, cx: &mut Context<Self>) {
        let chat = ChatRef {
            chat: ChatId(id.clone().into()),
            session: SessionId(id.into()),
        };
        self.store.open(Some(chat.clone()));
        self.show_view(false, cx);
        self.load_summary(&chat, cx);
        self.reload_open_chat(cx);
        self.composer.update(cx, |c, cx| {
            c.set_new_chat(false, cx);
            c.fold();
        });
        self.sync_composer(cx);
    }
    fn sidebar_input(&self) -> SharedString {
        format!("sidebar-input-{}", self.sidebar.dialog_serial).into()
    }
}
