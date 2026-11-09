//! `AutomationStore.remove`'s `confirmAction`: the delete asks before it runs.
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::dialog::{
    Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
};
use gpui::{AnyElement, Context, ParentElement as _, Window};

use super::copy::Words;
use super::{AutomationDetail, on_press, on_value};

impl AutomationDetail {
    /// The confirmation, while the owner has asked to delete.
    pub(super) fn delete_dialog(
        &self,
        words: &Words,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        if !self.confirm_delete {
            return None;
        }
        let message = (words.delete_schedule)(&self.form.title);
        let content = DialogContent::new().show_close_button(false).header(
            DialogHeader::new()
                .child(DialogTitle::new(words.delete))
                .child(DialogDescription::new(message)),
        );
        let cancel = Button::new("automation-delete-cancel")
            .size(Size::Sm)
            .variant(Variant::Ghost)
            .text(words.cancel)
            .on_click(on_press(cx, |this, _, cx| {
                this.confirm_delete = false;
                cx.notify();
            }));
        let accept = Button::new("automation-delete-accept")
            .size(Size::Sm)
            .variant(Variant::Destructive)
            .text(words.delete)
            .on_click(on_press(cx, |this, _, cx| {
                this.confirm_delete = false;
                this.remove(cx);
                cx.notify();
            }));
        let footer = DialogFooter::new().child(cancel).child(accept);
        let dialog = Dialog::new("automation-delete-confirm", window, cx)
            .open(true)
            .on_open_change(on_value(cx, |this: &mut Self, open: bool| {
                if !open {
                    this.confirm_delete = false;
                }
            }));
        Some(dialog.content(content.footer(footer), window, cx))
    }
}
