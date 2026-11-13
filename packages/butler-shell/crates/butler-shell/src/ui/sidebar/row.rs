//! SpaceRow, branch, identity and unfinished subtask lines use DS rows.
mod status;
mod subtasks;
use super::{Shell, canon_state::nested_chat_ids};
use crate::ui::{Icon, source::wire::SpaceNodeKind, store::navigation::SpaceRowData};
use butler_ds::ui::{
    blocks::{
        collapsible_nav_group::{CollapsibleNavGroup, StickyScroll},
        nav_row::{NavRow, NavRowSwap},
    },
    collapsible::{CollapsibleList, Row as CollapsibleRow},
    context::Ds,
    glyph_toggle::GlyphToggle,
    icon::{IconSize, icon},
    icon_button::IconButton,
    icon_slot::{IconSlot, SlotSize},
    layout::Space,
    typo::{Tone, Typo, Wrap},
    unread_dot::UnreadDot,
};
use gpui::{AnyElement, App, Context, SharedString, Window, div, prelude::*};

/// Where the sidebar's sticky headers hold: the scroller's recorder is the first row of the
/// SidebarShell (`Shell::sidebar_sticky(..).recorder()`), every branch header reads it.
const STICKY_ID: &str = "sidebar-sticky";

/// A sticky group: the scroller it holds in and `stickyDepth`, the number of sticky groups
/// around it.
#[derive(Clone, Copy)]
pub(super) struct Pin<'a> {
    pub(super) scroll: &'a StickyScroll,
    pub(super) depth: usize,
}

impl Shell {
    /// The sticky scroller of the sidebar tree; state is keyed, so every call is the same one.
    pub(super) fn sidebar_sticky(window: &mut Window, cx: &mut App) -> StickyScroll {
        StickyScroll::new(STICKY_ID, window, cx)
    }

    pub(super) fn space_row_actions(
        &mut self,
        row: &SpaceRowData,
        collapsible: bool,
        nested: bool,
        instance: &str,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let menu = self.space_row_menu(row, instance, cx);
        let rest = if collapsible {
            let expanded = !self.sidebar.collapsed.contains(&row.node.key);
            if !expanded
                && self
                    .store
                    .navigation
                    .unread_ancestors()
                    .contains(&row.node.key)
            {
                UnreadDot::new(
                    SharedString::from(format!("ancestor-{}", row.node.key)),
                    self.copy("Unread", "읽지 않음"),
                )
                .into_any_element()
            } else {
                let key = row.node.key.clone();
                IconButton::new(
                    SharedString::from(format!("toggle-{key}")),
                    self.copy("Expand or collapse", "펼치기 또는 접기"),
                )
                .glyph(if expanded {
                    Icon::ChevronDown
                } else {
                    Icon::ChevronRight
                })
                .on_click(cx.listener(move |s, _, _, cx| {
                    s.sidebar.toggle(&key);
                    s.refresh_canon(cx);
                    cx.notify();
                }))
                .into_any_element()
            }
        } else {
            self.space_activity(row, nested, cx)
        };
        let swap = NavRowSwap::new(SharedString::from(format!("swap-{instance}")), menu)
            .rest(rest)
            .open(self.sidebar.menus.contains(instance))
            .into_any_element();
        if row.project.is_some() {
            let project = SharedString::from(row.node.entityId.clone());
            let dashboard = IconButton::new(
                SharedString::from(format!("dashboard-{}", row.node.key)),
                self.copy("Project dashboard", "프로젝트 대시보드"),
            )
            .glyph(Icon::LayoutDashboard)
            .on_click(cx.listener(move |s, _, w, cx| {
                // The row's own click toggles the group; the action does not.
                cx.stop_propagation();
                s.open_project_dashboard(project.clone(), w, cx);
            }));
            gpui::div()
                .flex()
                .child(
                    crate::ui::widgets::anchor(
                        div(),
                        &format!("sidebar-dashboard-{}", row.node.entityId),
                    )
                    .child(dashboard),
                )
                .child(swap)
                .into_any_element()
        } else {
            swap
        }
    }

    pub(super) fn space_row_list(
        &self,
        id: impl Into<gpui::SharedString>,
        scope: impl Into<gpui::SharedString>,
        rows: Vec<SpaceRowData>,
        flat: bool,
        cx: &Context<Self>,
    ) -> AnyElement {
        let weak = cx.entity().downgrade();
        let instance_scope = self.sidebar.tab.value();
        let rows = rows.into_iter().map(move |row| {
            let weak = weak.clone();
            CollapsibleRow::new(row.node.key.clone(), move |window, cx| {
                let scroll = Self::sidebar_sticky(window, cx);
                weak.update(cx, |s, cx| {
                    let pin = Pin {
                        scroll: &scroll,
                        depth: row.ancestors.len(),
                    };
                    s.space_row_in(&row, (flat, false), instance_scope, Some(pin), cx)
                })
                .unwrap_or_else(|_| div().into_any_element())
            })
        });
        CollapsibleList::new(id.into())
            .scope(scope.into())
            .gap(Space::Xs)
            .rows(rows)
            .into_any_element()
    }
    pub(super) fn space_row(
        &mut self,
        row: &SpaceRowData,
        flat: bool,
        shortcut: bool,
        scope: &str,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        self.space_row_in(row, (flat, shortcut), scope, None, cx)
    }
    /// A row of the tree: `(flat, shortcut)` pick the Recent/Running list and pinned shortcuts.
    fn space_row_in(
        &mut self,
        row: &SpaceRowData,
        (flat, shortcut): (bool, bool),
        scope: &str,
        pin: Option<Pin<'_>>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let key = row.node.key.clone();
        let path = row
            .ancestors
            .iter()
            .map(String::as_str)
            .chain(std::iter::once(key.as_str()))
            .collect::<Vec<_>>()
            .join("/");
        let instance = format!("{scope}:{path}");
        let content = self.space_row_content(row, (flat, shortcut), &instance, pin, cx);
        let kind = if shortcut { "shortcut-row" } else { "row" };
        let content = Self::row_gestures(
            crate::ui::widgets::anchor(div(), &format!("sidebar-{kind}-{}", row.node.entityId))
                .id(gpui::SharedString::from(format!("space-row-{instance}"))),
            key,
            instance.clone(),
            cx,
        )
        .child(content)
        .into_any_element();
        let enabled = !flat && !shortcut;
        let content = if enabled || row.session.is_some() {
            self.space_drag_row(row, content, enabled, &instance, cx)
        } else {
            content
        };
        let mut block = div().flex().flex_col().child(content);
        if !flat
            && !shortcut
            && let Some(session) = &row.session
        {
            block = block.child(self.subtask_lines(session, cx));
        }
        block.into_any_element()
    }
    fn space_row_content(
        &mut self,
        row: &SpaceRowData,
        (flat, shortcut): (bool, bool),
        instance: &str,
        pin: Option<Pin<'_>>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let key = row.node.key.clone();
        let actions = self.space_row_actions(
            row,
            !shortcut && row.node.kind != SpaceNodeKind::Session,
            !flat && !shortcut && row.session.as_ref().is_some_and(|s| !s.subtasks.is_empty()),
            instance,
            cx,
        );
        if row.node.kind != SpaceNodeKind::Session && !shortcut {
            self.space_row_branch(row, actions, instance, pin, cx)
        } else {
            let identity = self.space_identity(row, None, cx);
            let id = row.node.entityId.clone();
            let click_instance = instance.to_owned();
            let mut nav = NavRow::new(
                gpui::SharedString::from(format!("row-{key}-{shortcut}")),
                row.title.clone(),
            )
            .icon(identity)
            .actions(actions);
            let project = row.project.is_some();
            nav = nav.on_click(cx.listener(move |s, _, w, cx| {
                if s.sidebar.take_long_press(&click_instance) {
                    return;
                }
                if project {
                    s.open_project_dashboard(id.clone().into(), w, cx);
                } else {
                    s.open_sidebar_session(&id, w, cx);
                }
            }));
            if crate::ui::store::navigation::NavigationModel::is_route_active(
                &row.node.entityId,
                self.route_chat(cx),
            ) {
                nav = nav.active();
            }
            if flat {
                nav = nav
                    .multiline()
                    .label_element(space_row_label(row, true))
                    .meta(self.space_row_meta(row, cx));
            }
            nav.into_any_element()
        }
    }
    pub(super) fn space_row_branch(
        &mut self,
        row: &SpaceRowData,
        actions: AnyElement,
        instance: &str,
        pin: Option<Pin<'_>>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let key = row.node.key.clone();
        let click_instance = instance.to_owned();
        let expanded = !self.sidebar.collapsed.contains(&key);
        let mut group = CollapsibleNavGroup::new(
            gpui::SharedString::from(key.clone()),
            row.title.clone(),
            expanded,
        )
        .glyph(space_glyph(row))
        .indented()
        .actions(actions)
        .on_toggle(cx.listener(move |s, _, _, cx| {
            if s.sidebar.take_long_press(&click_instance) {
                return;
            }
            s.sidebar.toggle(&key);
            s.refresh_canon(cx);
            cx.notify();
        }));
        if let Some(pin) = pin {
            group = group.sticky(pin.scroll, pin.depth);
        }
        let mut children = self.store.navigation.children(Some(&row.node.key));
        if let Some(project) = &row.project {
            let nested = nested_chat_ids(self.sidebar.canon.get(&project.id));
            children.retain(|child| !nested.contains(&child.node.entityId));
            if expanded {
                self.sidebar.canon_visible.insert(project.id.clone());
                if !self.sidebar.canon_previous.contains(&project.id) {
                    self.load_canon_sidebar(project.id.clone(), cx);
                }
            }
            let canon_pin = pin.map(|pin| Pin {
                depth: pin.depth + 1,
                ..pin
            });
            group = group.child(self.canon_sidebar_groups(&project.id, canon_pin, cx));
        }
        let visible = self
            .sidebar
            .branch_counts
            .get(&row.node.key)
            .copied()
            .unwrap_or(5);
        let active = self.store.selected().map(|c| c.session.0.as_ref());
        let reveal = children
            .iter()
            .position(|r| {
                self.sidebar.reveal_path.contains(&r.node.key)
                    || active == Some(r.node.entityId.as_str())
            })
            .map_or(0, |i| i + 1);
        let limit = visible.max(reveal);
        group = group.child(self.space_row_list(
            format!("space-children-{}", row.node.key),
            row.node.key.clone(),
            children.iter().take(limit).cloned().collect(),
            false,
            cx,
        ));
        if children.len() > limit {
            group = group.child(self.sidebar_session_load_more(
                Some(row.node.key.clone()),
                children.len() - limit,
                limit,
                cx,
            ));
        }
        group.into_any_element()
    }
    /// Electron SpaceIdentity: an optional glyph preserves the pin toggle.
    pub(super) fn space_identity(
        &mut self,
        row: &SpaceRowData,
        glyph: Option<Icon>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let glyph = IconSlot::new().size(SlotSize::Sidebar).child(icon(
            glyph.unwrap_or_else(|| space_glyph(row)),
            IconSize::Sm,
            Ds::get(cx),
        ));
        if row.node.entityId == "general" {
            return glyph.into_any_element();
        }
        let row = row.clone();
        GlyphToggle::new(
            gpui::SharedString::from(format!("pin-{}", row.node.key)),
            format!(
                "{} {}",
                row.title,
                if row.pinned {
                    self.copy("Unpin", "고정 해제")
                } else {
                    self.copy("Pin", "고정")
                }
            ),
            row.pinned,
        )
        .glyph(glyph)
        .toggle_glyph(icon(Icon::Sparkles, IconSize::Sm, Ds::get(cx)))
        .on_click(cx.listener(move |s, _, _, cx| {
            cx.stop_propagation();
            s.pin_sidebar_row(&row, cx);
        }))
        .into_any_element()
    }
    pub(super) fn space_row_meta(&self, row: &SpaceRowData, cx: &Context<Self>) -> AnyElement {
        let trailing = if self.sidebar.tab == super::Tab::Recent {
            Typo::caption(self.recent_age(&row.updated_at))
                .tabular()
                .wrap(Wrap::Nowrap)
                .tone(Tone::Secondary)
                .into_any_element()
        } else {
            let (status, progress) = self.space_row_status(row);
            let mut label = div()
                .flex()
                .min_w_0()
                .max_w(gpui::relative(0.6))
                .child(Typo::caption(status).tone(Tone::Secondary).truncate());
            if !progress.is_empty() {
                label = label.child(
                    div().flex_none().child(
                        Typo::caption(progress)
                            .tone(Tone::Secondary)
                            .wrap(Wrap::Pre),
                    ),
                );
            }
            label.into_any_element()
        };
        div()
            .flex()
            .items_baseline()
            .justify_between()
            .gap(Ds::get(cx).len(butler_ds::tokens::Length::SpaceSm))
            .child(
                div().flex_1().min_w_0().child(
                    Typo::caption(row.location.clone())
                        .tone(Tone::Secondary)
                        .truncate(),
                ),
            )
            .child(trailing)
            .into_any_element()
    }
    fn recent_age(&self, updated_at: &str) -> String {
        chrono::DateTime::parse_from_rfc3339(updated_at)
            .ok()
            .map(|at| {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |d| d.as_secs());
                self.theme.strings.relative_age(
                    i64::try_from(now)
                        .unwrap_or(i64::MAX)
                        .saturating_sub(at.timestamp())
                        .max(0),
                )
            })
            .unwrap_or_default()
    }
}
pub(super) fn space_glyph(row: &SpaceRowData) -> Icon {
    if row.node.entityId == "general" {
        Icon::GeneralChat
    } else {
        match row.node.kind {
            SpaceNodeKind::Group => Icon::Folder,
            SpaceNodeKind::Project => Icon::Briefcase,
            _ if row.node.scopeProjectId.is_some() => Icon::Notebook,
            _ => Icon::MessageSquare,
        }
    }
}

fn space_row_label(row: &SpaceRowData, flat: bool) -> Typo {
    let label = Typo::text(row.title.clone());
    if flat {
        label.line_clamp(2)
    } else {
        label.truncate()
    }
}
