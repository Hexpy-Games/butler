//! `AppUpdateDialog`: while work is active, the App asks whether to restart into the update now
//! or once the work finishes. Dismissing it defers.
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::Lang;
use butler_ds::ui::dialog::{
    Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
};
use gpui::{AnyElement, App, ParentElement as _, Window};

use crate::lifecycle::app_update::{self, AppUpdateStatus, dialog_words};

/// The choice while the update's status is `ChoiceRequired`.
pub(crate) fn update_choice(lang: Lang, window: &mut Window, cx: &mut App) -> Option<AnyElement> {
    let AppUpdateStatus::ChoiceRequired(request) = app_update::status(cx) else {
        return None;
    };
    let copy = dialog_words(lang);
    let (later, now, dismiss) = (request.clone(), request.clone(), request);
    // CARVE-OUT(G-dialog-focus): React focuses "later" on open and blocks outside presses.
    let footer = DialogFooter::new()
        .child(
            Button::new("app-update-later")
                .size(Size::Sm)
                .variant(Variant::Ghost)
                .text(copy.later)
                .on_click(move |_, _, cx| app_update::choose(&later, false, cx)),
        )
        .child(
            Button::new("app-update-now")
                .size(Size::Sm)
                .text(copy.now)
                .on_click(move |_, _, cx| app_update::choose(&now, true, cx)),
        );
    let content = DialogContent::new()
        .show_close_button(false)
        .header(
            DialogHeader::new()
                .child(DialogTitle::new(copy.title))
                .child(DialogDescription::new(copy.body)),
        )
        .footer(footer);
    let dialog = Dialog::new("app-update-choice", window, cx)
        .open(true)
        .on_open_change(move |open, _, cx| {
            if !open {
                app_update::choose(&dismiss, false, cx);
            }
        });
    Some(dialog.content(content, window, cx))
}
