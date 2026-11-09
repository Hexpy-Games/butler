//! `EpicDetailActions.tsx` and `useEpicDelete.tsx`: the epic's ⋯ menu and its delete dialog.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::dialog_form::DialogForm;
use butler_ds::ui::button::{self, Button, Size, Variant};
use butler_ds::ui::dialog::{Dialog, DialogContent, Size as DialogSize};
use butler_ds::ui::dropdown_menu::{
    DropdownMenu, DropdownMenuContent, Item, Variant as ItemVariant,
};
use butler_ds::ui::icon_button::IconButton;
use butler_ds::ui::layout::Justify;
use butler_ds::ui::toast::{self, Toast};
use butler_shell_client::Error;
use gpui::{AnyElement, Context, IntoElement as _, Window};
use gpui::{ParentElement as _, Styled as _};
use serde::Deserialize;
use serde_json::json;

use super::inspector::EpicInspector;
use crate::ui::source::fetch::fetch;
use crate::ui::source::wire::EpicCard;

#[derive(Default)]
pub(super) struct Delete {
    pub(super) open: bool,
    busy: bool,
}

/// `{ id }`
#[derive(Deserialize)]
struct Deleted {}

impl EpicInspector {
    /// `useEpicDelete`'s `submit`: a deleted epic leaves the aside through the canon event.
    fn delete_epic(&mut self, card: &EpicCard, cx: &mut Context<Self>) {
        if self.delete.busy {
            return;
        }
        self.delete.busy = true;
        cx.notify();
        let (id, revision) = (card.id.clone(), card.revision);
        fetch(
            cx,
            move |client| async move {
                client
                    .delete_canon_epic(&id, &json!({ "expected_revision": revision }))
                    .await
            },
            |this: &mut Self, result: Result<Deleted, Error>, cx| {
                this.delete.busy = false;
                let words = Self::words(cx);
                match result {
                    Ok(_) => {
                        this.delete.open = false;
                        toast::show(cx, Toast::message(words.deleted));
                    }
                    // CARVE-OUT(G-codes): `running` and `conflict` are both a 409; the epic is
                    // read again, which tells which (`delete_blocked`).
                    Err(Error::Http(409)) => {
                        toast::show(cx, Toast::error(words.conflict));
                        this.refresh(cx);
                    }
                    Err(_) => {
                        toast::show(cx, Toast::error(words.request_failed));
                    }
                }
            },
        );
    }

    /// `EpicDetailActions`: the ⋯ menu with Delete.
    pub(super) fn epic_menu(
        &self,
        card: &EpicCard,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let words = Self::words(cx);
        let menu = DropdownMenu::new("canon-epic-menu", window, cx);
        let (label, busy) = ((words.row_menu)(&card.title), self.busy);
        let trigger = menu.trigger(|toggle| {
            let button = IconButton::new("canon-epic-menu-trigger", label)
                .glyph(Icon::MoreHorizontal)
                .menu_trigger()
                .on_click(toggle.on_click());
            (if busy { button.disabled() } else { button }).into_any_element()
        });
        let blocked = card.delete_blocked == Some(true);
        let me = cx.weak_entity();
        let mut item = Item::new(words.delete)
            .variant(ItemVariant::Destructive)
            .on_select(move |_, cx| {
                let _ = me.update(cx, |this, cx| {
                    this.delete.open = true;
                    cx.notify();
                });
            });
        if busy || blocked {
            item = item.disabled();
        }
        if blocked {
            item = item.description([words.delete_running.into()]);
        }
        let content = menu.content(DropdownMenuContent::new().child(item), window, cx);
        gpui::div()
            .flex()
            .child(trigger)
            .child(content)
            .into_any_element()
    }

    /// `useEpicDelete`'s dialog.
    pub(super) fn delete_dialog(
        &self,
        card: &EpicCard,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        if !self.delete.open {
            return None;
        }
        let words = Self::words(cx);
        let busy = self.delete.busy;
        let (cancel, submit) = (
            Button::new("canon-delete-cancel")
                .size(Size::Sm)
                .variant(Variant::Ghost)
                .text(words.cancel)
                .on_click(cx.listener(|this, _, _, cx| {
                    this.delete.open = false;
                    cx.notify();
                })),
            Button::new("canon-delete-submit")
                .size(Size::Sm)
                .variant(Variant::Destructive)
                .text(words.delete)
                .on_click({
                    let card = card.clone();
                    cx.listener(move |this, _, _, cx| this.delete_epic(&card, cx))
                }),
        );
        let footer = button::container(Size::Sm)
            .justify(Justify::End)
            .child(if busy { cancel.disabled() } else { cancel })
            .child(if busy { submit.disabled() } else { submit });
        let me = cx.weak_entity();
        Some(
            Dialog::new("canon-delete-dialog", window, cx)
                .open(true)
                .on_open_change(move |open, _, cx| {
                    if !open && !busy {
                        let _ = me.update(cx, |this, cx| {
                            this.delete.open = false;
                            cx.notify();
                        });
                    }
                })
                .content(
                    DialogContent::new().size(DialogSize::Sm).child(
                        DialogForm::new((words.delete_title)(&card.title))
                            .description(words.delete_detail)
                            .footer(footer),
                    ),
                    window,
                    cx,
                )
                .into_any_element(),
        )
    }
}
