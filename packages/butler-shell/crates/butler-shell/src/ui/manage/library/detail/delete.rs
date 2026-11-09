//! `library/DeleteItemsDialog.tsx`: deleting the chosen items asks first.
use butler_ds::ui::blocks::dialog_form::DialogForm;
use butler_ds::ui::context::Ds;
use butler_ds::ui::toast::{self, Toast};
use gpui::{ClickEvent, Context, EventEmitter, IntoElement, Render, Window};

use super::api::delete_item;
use super::copy::words;
use super::dialogs::{DialogEvent, footer, shell};
use crate::ui::manage::library::types::LibraryItem;

pub(super) struct DeleteItems {
    items: Vec<LibraryItem>,
    busy: bool,
}

impl EventEmitter<DialogEvent> for DeleteItems {}

impl DeleteItems {
    pub(super) fn new(items: Vec<LibraryItem>) -> Self {
        Self { items, busy: false }
    }

    /// Deletes the items one after the other; the first failure stops and says so.
    fn remove(&mut self, cx: &mut Context<Self>) {
        self.busy = true;
        cx.notify();
        let ids: Vec<String> = self.items.iter().map(|item| item.id.clone()).collect();
        delete_next(ids, cx.weak_entity(), cx);
    }
}

fn delete_next(mut ids: Vec<String>, me: gpui::WeakEntity<DeleteItems>, cx: &mut gpui::App) {
    let Some(id) = ids.pop() else {
        let _ = me.update(cx, |_, cx| cx.emit(DialogEvent::Closed));
        return;
    };
    delete_item(cx, id, move |result, cx| {
        if result.is_ok() {
            delete_next(ids, me, cx);
            return;
        }
        toast::show(cx, Toast::error(words(Ds::get(cx).lang()).failed));
        let _ = me.update(cx, |this, cx| {
            this.busy = false;
            cx.notify();
        });
    });
}

impl Render for DeleteItems {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let copy = words(Ds::get(cx).lang());
        let count = i64::try_from(self.items.len()).unwrap_or(i64::MAX);
        let cancel = cx.listener(|_, _: &ClickEvent, _, cx| cx.emit(DialogEvent::Closed));
        let delete = cx.listener(|this, _: &ClickEvent, _, cx| this.remove(cx));
        let form = DialogForm::new((copy.delete_selected)(count))
            .description(copy.delete_selected_body)
            .footer(footer(
                "library-delete",
                (copy.cancel, cancel),
                (copy.delete_item, delete),
                self.busy,
                false,
            ));
        let me = cx.weak_entity();
        shell(
            ("library-delete-dialog", cx.entity_id()),
            form,
            self.busy,
            move |_, cx| {
                let _ = me.update(cx, |_, cx| cx.emit(DialogEvent::Closed));
            },
            window,
            cx,
        )
    }
}
