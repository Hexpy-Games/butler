//! GeneralChannelMenu waits for fresh activity/authority before enabling Clear.
use super::Shell;
use crate::ui::source::SessionId;
use butler_ds::ui::{
    button::Button,
    dialog::{DialogContent, DialogDescription, DialogHeader, DialogTitle},
    dropdown_menu::{DropdownMenu, DropdownMenuContent, Item},
    icon_button::IconButton,
    tooltip::Tooltip,
};
use gpui::{
    App, Context, IntoElement, ParentElement as _, RenderOnce, WeakEntity, Window, div,
    prelude::FluentBuilder as _,
};
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
        div().child(trigger).child(content)
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
