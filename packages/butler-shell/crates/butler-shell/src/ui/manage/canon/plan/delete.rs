//! `useEpicDelete.tsx`: the confirmation of deleting an epic from the plan list.
use butler_ds::ui::blocks::dialog_form::DialogForm;
use butler_ds::ui::button::{self, Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::dialog::{Dialog, DialogContent, Size as DialogSize};
use butler_ds::ui::layout::Justify;
use butler_ds::ui::toast::{self, Toast};
use butler_shell_client::Error;
use gpui::ParentElement as _;
use gpui::{Context, IntoElement, Render, Window};
use serde::Deserialize;
use serde_json::json;

use super::copy::words;
use super::feedback::write_failure;
use crate::ui::manage::Action;
use crate::ui::source::fetch::fetch;
use crate::ui::source::wire::EpicCard;

/// `{ id }`
#[derive(Deserialize)]
struct Deleted {}

/// The delete dialog of one epic; `on_close` unmounts it, `on_refresh` reads the board again.
pub(super) struct EpicDeleteDialog {
    epic: EpicCard,
    on_close: Action,
    on_refresh: Action,
    busy: bool,
}

impl EpicDeleteDialog {
    pub(super) fn new(epic: EpicCard, on_close: Action, on_refresh: Action) -> Self {
        Self {
            epic,
            on_close,
            on_refresh,
            busy: false,
        }
    }

    fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        self.busy = true;
        cx.notify();
        let (id, revision) = (self.epic.id.clone(), self.epic.revision);
        let handle = window.window_handle();
        fetch(
            cx,
            move |client| async move {
                client
                    .delete_canon_epic(&id, &json!({ "expected_revision": revision }))
                    .await
            },
            move |this: &mut Self, result: Result<Deleted, Error>, cx| {
                this.busy = false;
                let conflict = match &result {
                    Ok(_) => {
                        let copy = words(Ds::get(cx).lang());
                        toast::show(cx, Toast::message(copy.deleted));
                        false
                    }
                    Err(error) => write_failure(error, cx),
                };
                let (refresh, close) = (this.on_refresh.clone(), this.on_close.clone());
                let done = result.is_ok();
                let _ = handle.update(cx, move |_, window, cx| {
                    refresh(window, cx);
                    if done || conflict {
                        close(window, cx);
                    }
                });
                cx.notify();
            },
        );
    }
}

impl Render for EpicDeleteDialog {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let copy = words(Ds::get(cx).lang());
        let busy = self.busy;
        let close = self.on_close.clone();
        let (cancel_close, submit) = (close.clone(), cx.entity());
        let cancel = Button::new("canon-plan-delete-cancel")
            .size(Size::Sm)
            .variant(Variant::Ghost)
            .text(copy.cancel)
            .on_click(move |_, window, cx| cancel_close(window, cx));
        let confirm = Button::new("canon-plan-delete-submit")
            .size(Size::Sm)
            .variant(Variant::Destructive)
            .text(copy.delete)
            .on_click(move |_, window, cx| {
                submit.update(cx, |this, cx| this.submit(window, cx));
            });
        let footer = button::container(Size::Sm)
            .justify(Justify::End)
            .child(if busy { cancel.disabled() } else { cancel })
            .child(if busy { confirm.disabled() } else { confirm });
        let form = DialogForm::new((copy.delete_title)(&self.epic.title))
            .description(copy.delete_detail)
            .footer(footer);
        Dialog::new("canon-plan-delete-dialog", window, cx)
            .open(true)
            .on_open_change(move |open, window, cx| {
                if !open && !busy {
                    close(window, cx);
                }
            })
            .content(
                DialogContent::new().size(DialogSize::Sm).child(form),
                window,
                cx,
            )
    }
}
