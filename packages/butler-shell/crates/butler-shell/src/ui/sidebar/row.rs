//! SpaceRow, branch, identity and unfinished subtask lines use DS rows.
use super::Shell;
use crate::ui::{Icon, source::wire::SpaceNodeKind, store::navigation::SpaceRowData};
use butler_ds::ui::{
    blocks::{
        collapsible_nav_group::CollapsibleNavGroup,
        nav_row::{NavRow, NavRowChildren},
    },
    context::Ds,
    glyph_toggle::GlyphToggle,
    icon::{IconSize, icon},
    icon_slot::{IconSlot, SlotSize},
    typo::{Tone, Typo},
};
use gpui::{AnyElement, Context, div, prelude::*};
impl Shell {
    pub(super) fn space_row(
        &mut self,
        row: &SpaceRowData,
        flat: bool,
        shortcut: bool,
        scope: &str,
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
        let content = self.space_row_content(row, flat, shortcut, &instance, cx);
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
        flat: bool,
        shortcut: bool,
        instance: &str,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let key = row.node.key.clone();
        let actions = self.space_row_actions(
            row,
            !shortcut && row.node.kind != SpaceNodeKind::Session,
            instance,
            cx,
        );
        if row.node.kind != SpaceNodeKind::Session && !shortcut {
            self.space_row_branch(row, actions, instance, cx)
        } else {
            let identity = self.space_identity(row, cx);
            let id = row.node.entityId.clone();
            let click_instance = instance.to_owned();
            let mut nav = NavRow::new(
                gpui::SharedString::from(format!("row-{key}-{shortcut}")),
                row.title.clone(),
            )
            .icon(identity)
            .actions(actions);
            if row.project.is_some() {
                nav = nav.disabled();
            } else {
                nav = nav.on_click(cx.listener(move |s, _, w, cx| {
                    if !s.sidebar.take_long_press(&click_instance) {
                        s.open_sidebar_session(&id, w, cx);
                    }
                }));
            }
            if crate::ui::store::navigation::NavigationModel::is_route_active(
                &row.node.entityId,
                self.store.selected().map(|c| c.session.0.as_ref()),
            ) {
                nav = nav.active();
            }
            if flat {
                nav = nav
                    .multiline()
                    .label_element(space_row_label(row, true))
                    .meta(self.space_row_meta(row));
            }
            if row.project.is_some() {
                butler_ds::ui::tooltip::Tooltip::new(gpui::SharedString::from(format!(
                    "project-shortcut-{}",
                    row.node.key
                )))
                .label(self.theme.strings.not_yet)
                .child(nav)
                .into_any_element()
            } else {
                nav.into_any_element()
            }
        }
    }
    pub(super) fn space_row_branch(
        &mut self,
        row: &SpaceRowData,
        actions: AnyElement,
        instance: &str,
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
        if expanded {
            if let Some(project) = &row.project {
                self.sidebar.canon_visible.insert(project.id.clone());
                if !self.sidebar.canon_previous.contains(&project.id) {
                    self.load_canon_sidebar(project.id.clone(), cx);
                }
                group = group.child(self.canon_sidebar_groups(&project.id, cx));
            }
            let children = self.store.navigation.children(Some(&row.node.key));
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
            for child in children.iter().take(limit) {
                group =
                    group.child(self.space_row(child, false, false, self.sidebar.tab.value(), cx));
            }
            if children.len() > limit {
                group = group.child(self.sidebar_session_load_more(
                    Some(row.node.key.clone()),
                    children.len() - limit,
                    limit,
                    cx,
                ));
            }
        }
        group.into_any_element()
    }
    pub(super) fn space_identity(
        &mut self,
        row: &SpaceRowData,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let glyph = IconSlot::new().size(SlotSize::Sidebar).child(icon(
            space_glyph(row),
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
    pub(super) fn space_row_meta(&self, row: &SpaceRowData) -> AnyElement {
        let age = chrono::DateTime::parse_from_rfc3339(&row.updated_at)
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
            .unwrap_or_default();
        div()
            .flex()
            .justify_between()
            .child(Typo::caption(row.location.clone()).tone(Tone::Secondary))
            .child(Typo::caption(age).tone(Tone::Secondary))
            .into_any_element()
    }
    pub(super) fn subtask_lines(
        &self,
        session: &crate::ui::source::wire::SessionSummary,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let mut children = NavRowChildren::new();
        for task in &session.subtasks {
            children = children.child(self.subtask_line(&session.id, task, cx));
        }
        children.into_any_element()
    }
    fn subtask_line(
        &self,
        parent_id: &str,
        task: &crate::ui::source::wire::SubtaskView,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let id = task.session_id.clone();
        let parent = parent_id.to_owned();
        let mark = match task.state {
            crate::ui::source::wire::SubtaskState::Paused => {
                let relation = task.relation_id.clone();
                let weak = cx.entity().downgrade();
                butler_ds::ui::icon_button::IconButton::new(
                    gpui::SharedString::from(format!("resume-{id}")),
                    self.copy("Resume", "계속하기"),
                )
                .glyph(Icon::Play)
                .on_click(move |_, _, cx| {
                    let _ = weak.update(cx, |s, cx| {
                        s.mutate(
                            crate::ui::source::sidebar::Mutation::ResumeSubtask(
                                relation.clone(),
                                parent.clone(),
                            ),
                            cx,
                        );
                    });
                })
                .into_any_element()
            }
            crate::ui::source::wire::SubtaskState::NeedsApproval => {
                icon(Icon::CircleAlert, IconSize::Sm, Ds::get(cx)).into_any_element()
            }
            _ => Typo::caption(match (task.plan_completed, task.plan_total) {
                (Some(done), Some(total)) if total > 0 => {
                    format!("{}/{total}", done.max(0).saturating_add(1).min(total))
                }
                _ => String::new(),
            })
            .tone(Tone::Secondary)
            .into_any_element(),
        };
        NavRow::new(
            gpui::SharedString::from(format!("subtask-{id}")),
            task.title.clone(),
        )
        .reserve_icon()
        .actions(mark)
        .disabled()
        .into_any_element()
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
    let label = Typo::body(row.title.clone());
    if flat {
        label.line_clamp(2)
    } else {
        label.truncate()
    }
}
