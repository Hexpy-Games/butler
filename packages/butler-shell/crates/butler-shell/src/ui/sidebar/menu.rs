//! SpaceRowMenu and disclosure/status swaps.
use super::{Shell, dialogs::SpaceDialog, drag::SpaceDragPayload};
use crate::ui::source::SessionId;
use crate::ui::{
    Icon,
    source::{
        sidebar::{Mutation, ProjectCommand, SessionCommand, SpaceCommand},
        wire::SpaceNodeKind,
    },
    store::navigation::SpaceRowData,
};
use butler_ds::ui::blocks::overflow_action_menu::{OverflowActionMenu, OverflowItem};
use butler_ds::ui::{
    button::Button,
    dialog::{DialogContent, DialogDescription, DialogHeader, DialogTitle},
    dropdown_menu::{DropdownMenu, DropdownMenuContent, Item},
    icon_button::IconButton,
    tooltip::Tooltip,
};
use gpui::{AnyElement, App, Context, WeakEntity, Window, div, prelude::*};
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
    pub(super) fn space_row_menu(
        &self,
        row: &SpaceRowData,
        instance: &str,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        if row.node.entityId == "general" {
            return GeneralChannelMenu {
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
                    s.sidebar_action(&row, &action, &instance, w, cx);
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

#[derive(IntoElement)]
pub(super) struct GeneralChannelMenu {
    pub(super) shell: WeakEntity<Shell>,
    pub(super) open: bool,
    pub(super) instance: String,
    pub(super) busy: bool,
    pub(super) label: &'static str,
    pub(super) reference_label: &'static str,
}
impl RenderOnce for GeneralChannelMenu {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let weak = self.shell.clone();
        let close = self.shell.clone();
        let reference = self.shell.clone();
        let instance = self.instance.clone();
        let menu = DropdownMenu::new(
            gpui::SharedString::from(format!("general-menu-{}", self.instance)),
            window,
            cx,
        )
        .open(self.open)
        .on_open_change(move |open, _, cx| {
            let _ = weak.update(cx, |s, cx| {
                if open {
                    s.sidebar.menus.insert(instance.clone());
                    s.load_general_menu(cx);
                } else {
                    s.sidebar.menus.remove(&instance);
                }
                cx.notify();
            });
        });
        let trigger = menu.trigger(|toggle| {
            IconButton::new("sidebar-general-trigger", self.label)
                .glyph(crate::ui::Icon::MoreHorizontal)
                .on_click(toggle.on_click())
                .into_any_element()
        });
        let reference_label = self.reference_label;
        let clear = Item::new(self.label);
        let clear = if self.busy { clear.disabled() } else { clear };
        let content = DropdownMenuContent::new()
            .child(Item::new(reference_label).on_select(move |_, cx| {
                let _ = reference.update(cx, |s, cx| {
                    s.sidebar.reference = Some(super::drag::SpaceDragPayload::SessionReference(
                        "general".to_owned(),
                    ));
                    cx.notify();
                });
            }))
            .child(clear.on_select(move |_, cx| {
                let _ = close.update(cx, |s, cx| {
                    s.sidebar
                        .set_dialog(Some(super::dialogs::SpaceDialog::Clear));
                    cx.notify();
                });
            }));
        let content = menu.content(content, window, cx);
        div().flex().child(trigger).child(content)
    }
}
impl Shell {
    pub(super) fn confirm_clear_general(&mut self, cx: &mut Context<Self>) {
        let now = chrono::Local::now();
        let title = format!(
            "{} · {}",
            self.copy("Chats", "대화"),
            now.format(self.copy("%b %-d, %Y", "%Y. %-m. %-d."))
        );
        self.mutate(
            crate::ui::source::sidebar::Mutation::ClearGeneral(serde_json::json!({"title":title})),
            cx,
        );
    }
    pub(super) fn clear_general_dialog(&self, cx: &Context<Self>) -> DialogContent {
        let weak = cx.entity().downgrade();
        let busy = self.general_clear_busy();
        let save = Button::new("general-clear")
            .text(self.copy("Clear", "비우기"))
            .when(self.sidebar.pending || busy, Button::disabled)
            .on_click(move |_, _, cx| {
                let _ = weak.update(cx, |s, cx| {
                    if !s.general_clear_busy() {
                        s.confirm_clear_general(cx);
                    }
                });
            });
        DialogContent::new()
            .header(
                DialogHeader::new()
                    .child(DialogTitle::new(self.copy("Clear chat", "대화 비우기")))
                    .child(DialogDescription::new(self.copy(
                        "This chat moves to Archive and you start fresh. Instructions and memories stay.",
                        "지금까지의 대화는 아카이브에 보관되고, 빈 화면에서 새로 시작합니다. 지침과 대화 기억은 그대로 유지됩니다.",
                    ))),
            )
            .child(
                Tooltip::new("general-memory-tip")
                    .label(self.theme.strings.not_yet)
                    .child(
                        Button::new("general-memory")
                            .text(self.copy("Manage memory ›", "지침·기억 관리 ›"))
                            .variant(butler_ds::ui::button::Variant::Link)
                            .disabled(),
                    ),
            )
            .child(
                Tooltip::new("general-clear-busy-tip")
                    .label(if busy {
                        self.copy("Wait for pending work to finish.", "진행 중인 작업이 끝나면 비울 수 있습니다.")
                    } else {
                        ""
                    })
                    .child(self.space_dialog_footer(save, cx)),
            )
    }
    pub(super) fn load_general_menu(&mut self, cx: &mut Context<Self>) {
        if self.sidebar.general_loading {
            return;
        }
        let Some(source) = self.source.clone() else {
            return;
        };
        self.sidebar.general_loading = true;
        self.sidebar.general_ready = false;
        let epoch = self.store.epoch();
        let id = SessionId("general".into());
        Self::run(
            Box::pin(async move { futures::try_join!(source.summary(&id), source.authority(&id)) }),
            cx,
            move |s, result, cx| {
                if epoch != s.store.epoch() {
                    return;
                }
                s.sidebar.general_loading = false;
                if let Ok((summary, authority)) = result {
                    s.sidebar.general_ready = true;
                    s.sidebar.general_busy = summary.turn_state.as_deref().is_some_and(|state| {
                        matches!(
                            state,
                            "queued"
                                | "accepted"
                                | "thinking"
                                | "streaming"
                                | "waiting_for_form"
                                | "waiting_for_tool"
                                | "cancelling"
                                | "retrying"
                                | "session_starting"
                        )
                    }) || !authority.is_empty();
                }
                cx.notify();
            },
        );
    }
    pub(super) fn general_clear_busy(&self) -> bool {
        !self.sidebar.general_ready
            || self.sidebar.general_busy
            || self
                .store
                .navigation
                .rows
                .get("s:general")
                .and_then(|r| r.session.as_ref())
                .is_some_and(|s| {
                    s.attention_required
                        || s.running_delegated_work
                        || s.active_turn_state.as_ref().is_some_and(|state| {
                            matches!(
                                state,
                                crate::ui::source::wire::TurnState::Queued
                                    | crate::ui::source::wire::TurnState::Accepted
                                    | crate::ui::source::wire::TurnState::Thinking
                                    | crate::ui::source::wire::TurnState::Streaming
                                    | crate::ui::source::wire::TurnState::WaitingForForm
                                    | crate::ui::source::wire::TurnState::WaitingForTool
                                    | crate::ui::source::wire::TurnState::Cancelling
                                    | crate::ui::source::wire::TurnState::Retrying
                            )
                        })
                })
    }
}
