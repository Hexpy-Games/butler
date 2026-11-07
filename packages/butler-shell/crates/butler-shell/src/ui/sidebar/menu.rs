//! SpaceRowMenu and disclosure/status swaps.
use super::{Shell, dialogs::SpaceDialog, drag::SpaceDragPayload};
use crate::ui::{
    Icon,
    source::{
        sidebar::{Mutation, ProjectCommand, SessionCommand, SpaceCommand},
        wire::SpaceNodeKind,
    },
    store::navigation::SpaceRowData,
};
use butler_ds::ui::{
    blocks::{
        nav_row::NavRowSwap,
        overflow_action_menu::{OverflowActionMenu, OverflowItem},
    },
    icon_button::IconButton,
    unread_dot::UnreadDot,
};
use gpui::{AnyElement, Context, SharedString, prelude::*};
#[derive(Clone)]
enum Action {
    NewChat,
    Reference,
    Rename,
    Move,
    Create,
    Dissolve,
    Pin,
    Archive,
    Delete,
}
impl Shell {
    pub(super) fn space_row_actions(
        &mut self,
        row: &SpaceRowData,
        collapsible: bool,
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
            self.space_activity(row, cx)
        };
        let swap = NavRowSwap::new(SharedString::from(format!("swap-{instance}")), menu)
            .rest(rest)
            .open(self.sidebar.menus.contains(instance))
            .into_any_element();
        if row.project.is_some() {
            let dashboard = butler_ds::ui::tooltip::Tooltip::new(SharedString::from(format!(
                "dashboard-{}",
                row.node.key
            )))
            .label(self.theme.strings.not_yet)
            .child(
                IconButton::new(
                    SharedString::from(format!("dashboard-{}", row.node.key)),
                    self.copy("Dashboard", "대시보드"),
                )
                .glyph(Icon::LayoutDashboard)
                .disabled(),
            );
            gpui::div()
                .flex()
                .child(dashboard)
                .child(swap)
                .into_any_element()
        } else {
            swap
        }
    }
    pub(super) fn space_row_menu(
        &self,
        row: &SpaceRowData,
        instance: &str,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        if row.node.entityId == "general" {
            return super::general::GeneralChannelMenu {
                shell: cx.entity().downgrade(),
                instance: instance.to_owned(),
                open: self.sidebar.menus.contains(instance),
                busy: self.general_clear_busy(),
                label: self.copy("Clear conversation", "대화 비우기"),
                reference_label: self.copy("Reference", "참조하기"),
            }
            .into_any_element();
        }
        let key = instance.to_owned();
        let weak = cx.entity().downgrade();
        let mut menu = OverflowActionMenu::new(format!("menu-{key}"), row.title.clone())
            .open(self.sidebar.menus.contains(&key))
            .on_open_change(move |open, _, cx| {
                let _ = weak.update(cx, |s, cx| {
                    if open {
                        s.sidebar.menus.insert(key.clone());
                    } else {
                        s.sidebar.menus.remove(&key);
                    }
                    cx.notify();
                });
            });
        let actions = self.space_menu_items(row);
        for (label, icon, action) in actions {
            let row = row.clone();
            let instance = instance.to_owned();
            let weak = cx.entity().downgrade();
            let item = OverflowItem::new(label).icon(icon).on_select(move |w, cx| {
                let _ = weak.update(cx, |s, cx| {
                    s.sidebar_action(&row, &action, &instance, w, cx)
                });
            });
            menu = menu.item(item);
        }
        crate::ui::widgets::anchor(gpui::div(), &format!("sidebar-menu-{instance}"))
            .child(menu)
            .into_any_element()
    }
    fn space_menu_items(&self, row: &SpaceRowData) -> Vec<(&'static str, Icon, Action)> {
        let mut actions = Vec::new();
        if row.node.kind != SpaceNodeKind::Session {
            actions.push((
                self.theme.strings.new_chat,
                Icon::MessageSquarePlus,
                Action::NewChat,
            ));
        }
        if row.session.is_some() {
            actions.push((
                self.copy("Reference", "참조하기"),
                Icon::MessageSquarePlus,
                Action::Reference,
            ));
        }
        {
            actions.extend([
                (
                    self.copy("Rename", "이름 변경"),
                    Icon::PencilLine,
                    Action::Rename,
                ),
                (self.copy("Move", "이동"), Icon::Folder, Action::Move),
            ]);
            if row.node.kind == SpaceNodeKind::Group {
                actions.extend([
                    (
                        self.copy("Subgroup", "하위 그룹"),
                        Icon::Folder,
                        Action::Create,
                    ),
                    (
                        self.copy("Dissolve", "그룹 해제"),
                        Icon::Trash2,
                        Action::Dissolve,
                    ),
                ]);
            } else {
                actions.extend([
                    (
                        if row.pinned {
                            self.copy("Unpin", "고정 해제")
                        } else {
                            self.copy("Pin", "고정")
                        },
                        Icon::Pin,
                        Action::Pin,
                    ),
                    (self.copy("Archive", "보관"), Icon::Archive, Action::Archive),
                    (self.copy("Delete", "삭제"), Icon::Trash2, Action::Delete),
                ]);
            }
        }
        actions
    }
    fn sidebar_action(
        &mut self,
        row: &SpaceRowData,
        action: &Action,
        instance: &str,
        window: &mut gpui::Window,
        cx: &mut Context<Self>,
    ) {
        let key = row.node.key.clone();
        let id = row.node.entityId.clone();
        self.sidebar.menus.remove(instance);
        match action {
            Action::NewChat => {
                self.open_chat(None, window, cx);
                self.sidebar.new_chat_parent = Some(if row.project.is_some() {
                    crate::ui::source::sidebar::DraftTarget::Project(id)
                } else {
                    crate::ui::source::sidebar::DraftTarget::Group {
                        id,
                        project: row.node.scopeProjectId.clone(),
                    }
                });
            }
            Action::Reference => {
                self.sidebar.reference = Some(SpaceDragPayload::SessionReference(id));
            }
            Action::Rename => self
                .sidebar
                .set_dialog(Some(SpaceDialog::Rename(key, row.title.clone()))),
            Action::Move => self.sidebar.set_dialog(Some(SpaceDialog::Move(key))),
            Action::Create => self
                .sidebar
                .set_dialog(Some(SpaceDialog::Create(Some(key)))),
            Action::Dissolve => self.space_mutate(
                SpaceCommand::Dissolve(id.clone()),
                serde_json::json!({"action":"dissolve","groupId":id}),
                cx,
            ),
            Action::Pin => self.pin_sidebar_row(row, cx),
            Action::Archive | Action::Delete => {
                let delete = matches!(action, Action::Delete);
                if delete {
                    self.sidebar.set_dialog(Some(SpaceDialog::Delete(key)));
                    cx.notify();
                    return;
                }
                let mutation = if row.project.is_some() {
                    Mutation::Project(
                        id,
                        if delete {
                            ProjectCommand::Delete
                        } else {
                            ProjectCommand::Archive
                        },
                    )
                } else {
                    Mutation::Session(
                        id,
                        if delete {
                            SessionCommand::Delete
                        } else {
                            SessionCommand::Archive
                        },
                    )
                };
                self.mutate(mutation, cx);
            }
        }
        cx.notify();
    }
}
