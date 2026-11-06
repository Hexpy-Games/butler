//! Session menu and rename dialog use DS overlays and the Source boundary.
use super::Shell;
use crate::ui::{
    Icon,
    source::{ChatRef, SessionAction, wire},
};
use butler_ds::ui::{
    button::{Button, Variant},
    dialog::{Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle},
    dropdown_menu::{DropdownMenu, DropdownMenuContent, Item},
    icon_button::IconButton,
    overlay::place::Align,
    text::{self, Input},
};
use gpui::{AnyElement, Context, IntoElement as _, Window, div, prelude::*};

#[derive(Default)]
pub(super) struct SessionMenu {
    pub summary: Option<wire::SessionSummaryView>,
    pub(super) rename: Option<ChatRef>,
    rename_serial: u64,
}

impl Shell {
    pub(super) fn load_summary(&mut self, chat: &ChatRef, cx: &mut Context<Self>) {
        self.session_menu.summary = None;
        let Some(source) = self.source.clone() else {
            return;
        };
        let chat = chat.clone();
        Self::run(source.summary(&chat.session), cx, move |s, result, cx| {
            if s.store.selected() == Some(&chat) {
                if let Ok(summary) = result {
                    s.session_menu.summary = Some(summary);
                }
                cx.notify();
            }
        });
    }

    pub(super) fn render_session_menu(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let menu = DropdownMenu::new("session-menu", window, cx);
        let Some(chat) = self.store.selected().cloned() else {
            return div().into_any_element();
        };
        let rename = cx.entity().downgrade();
        let rename_chat = chat.clone();
        let mut content = DropdownMenuContent::new()
            .align(Align::End)
            .side_offset(18.)
            .child(
                Item::new(self.copy("Rename", "이름 변경"))
                    .icon(Icon::PencilLine)
                    .on_select(move |_, cx| {
                        let _ = rename.update(cx, |s, cx| {
                            s.session_menu.rename_serial += 1;
                            s.session_menu.rename = Some(rename_chat.clone());
                            cx.notify();
                        });
                    }),
            );
        // Folder launching is an Electron native bridge; no ShellClient route exists yet.
        content = content.child(
            Item::new(self.copy("Open work folder", "작업 폴더 열기"))
                .icon(Icon::FolderOpen)
                .disabled(),
        );
        for (label, glyph, action) in [
            (
                self.copy("Archive", "보관"),
                Icon::Archive,
                SessionAction::Archive,
            ),
            (
                self.copy("Delete", "삭제"),
                Icon::Trash2,
                SessionAction::Delete,
            ),
        ] {
            let entity = cx.entity().downgrade();
            let chat = chat.clone();
            content = content.child(Item::new(label).icon(glyph).on_select(move |_, cx| {
                let action = match action {
                    SessionAction::Archive => SessionAction::Archive,
                    _ => SessionAction::Delete,
                };
                let _ = entity.update(cx, |s, cx| s.run_session_action(&chat, action, cx));
            }));
        }
        let selected = menu.is_open(cx);
        let trigger = menu.trigger(|toggle| {
            IconButton::new(
                "session-menu-trigger",
                self.copy("Session menu", "세션 메뉴"),
            )
            .glyph(Icon::MoreHorizontal)
            .menu_trigger()
            .when(selected, IconButton::selected)
            .on_click(toggle.on_click())
            .into_any_element()
        });
        let content = menu.content(content, window, cx);
        div()
            .flex()
            .child(crate::ui::widgets::anchor(div(), "session-menu-trigger").child(trigger))
            .child(content)
            .into_any_element()
    }

    fn run_session_action(
        &mut self,
        chat: &ChatRef,
        action: SessionAction,
        cx: &mut Context<Self>,
    ) {
        let Some(source) = self.source.clone() else {
            return;
        };
        Self::run(
            source.session_action(&chat.session, action),
            cx,
            move |s, result, cx| {
                match result {
                    Ok(()) => {
                        s.session_menu.rename = None;
                        s.connect(cx);
                    }
                    Err(e) => s.failed(&e, s.theme.strings.load_failed, cx),
                }
                cx.notify();
            },
        );
    }

    pub(super) fn render_rename(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let weak = cx.entity().downgrade();
        let dialog = Dialog::new("rename-session", window, cx)
            .open(self.session_menu.rename.is_some())
            .on_open_change(move |open, _, cx| {
                if !open {
                    let _ = weak.update(cx, |s, cx| {
                        s.session_menu.rename = None;
                        cx.notify();
                    });
                }
            });
        let chat = self.session_menu.rename.clone();
        let title = chat
            .as_ref()
            .and_then(|c| self.store.summary(c))
            .map(|r| r.title.clone())
            .unwrap_or_default();
        let input_id =
            gpui::SharedString::from(format!("rename-title-{}", self.session_menu.rename_serial));
        let entity = cx.entity().downgrade();
        let save = Button::new("rename-save")
            .text(self.copy("Save", "저장"))
            .on_click(move |_, w, cx| {
                let title = text::state(input_id.clone(), w, cx)
                    .read(cx)
                    .as_str()
                    .trim()
                    .to_owned();
                if !title.is_empty()
                    && let Some(chat) = chat.clone()
                {
                    let _ = entity.update(cx, |s, cx| {
                        s.run_session_action(&chat, SessionAction::Rename(title), cx);
                    });
                }
            });
        let content = DialogContent::new()
            .header(DialogHeader::new().child(DialogTitle::new(
                self.copy("Rename session", "세션 이름 변경"),
            )))
            .child(
                Input::new(gpui::SharedString::from(format!(
                    "rename-title-{}",
                    self.session_menu.rename_serial
                )))
                .default_value(title),
            )
            .footer(
                DialogFooter::new()
                    .child(
                        Button::new("rename-cancel")
                            .variant(Variant::Outline)
                            .text(self.theme.strings.cancel)
                            .on_click(dialog.closer().on_click()),
                    )
                    .child(save),
            );
        dialog.content(content, window, cx)
    }
}
