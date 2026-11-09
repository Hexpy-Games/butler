//! `HistoryClearDialog`: clear a range of the browsing history.
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::dialog::{Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle};
use butler_ds::ui::layout::{Cross, Justify, Space, Stack};
use butler_ds::ui::native_select::NativeSelect;
use butler_ds::ui::switch::Switch;
use butler_ds::ui::toast::{self, Toast};
use butler_ds::ui::typo::Typo;
use butler_shell_client::Error;
use gpui::{
    Context, EventEmitter, IntoElement, ParentElement as _, Render, SharedString, Window, div,
};
use serde_json::{Value, json};

use super::copy::words;
use crate::ui::source::fetch::fetch;

/// What the dialog asks the page: close, or reload (the history changed).
pub(super) enum ClearEvent {
    Close,
    Cleared,
}

pub(super) struct HistoryClear {
    range: SharedString,
    only: bool,
    busy: bool,
}

impl EventEmitter<ClearEvent> for HistoryClear {}

impl HistoryClear {
    pub(super) fn new() -> Self {
        Self {
            range: "hour".into(),
            only: false,
            busy: false,
        }
    }

    /// `onOpenChange`: it never closes while the request runs.
    fn close(&mut self, cx: &mut Context<Self>) {
        if !self.busy {
            cx.emit(ClearEvent::Close);
        }
    }

    /// `clear()`: POST /browser-history/clear.
    fn clear(&mut self, cx: &mut Context<Self>) {
        self.busy = true;
        let body = json!({ "range": self.range.to_string(), "butlerOnly": self.only });
        cx.notify();
        fetch(
            cx,
            move |client| async move { client.clear_browser_history(&body).await },
            |this: &mut Self, result: Result<Value, Error>, cx| {
                this.busy = false;
                match result {
                    Ok(_) => {
                        cx.emit(ClearEvent::Cleared);
                        cx.emit(ClearEvent::Close);
                    }
                    Err(_) => {
                        let copy = words(Ds::get(cx).lang());
                        toast::show(cx, Toast::error(copy.failed));
                    }
                }
            },
        );
    }
}

fn disabled_if(button: Button, disabled: bool) -> Button {
    if disabled { button.disabled() } else { button }
}

impl Render for HistoryClear {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let copy = words(Ds::get(cx).lang());
        let me = cx.entity();
        let dismiss = me.clone();
        let dialog = Dialog::new("history-clear", window, cx)
            .open(true)
            .on_open_change(move |open, _, cx| {
                if !open {
                    dismiss.update(cx, Self::close);
                }
            });
        let pick = me.clone();
        let range = copy.ranges.iter().fold(
            NativeSelect::new("history-clear-range").value(self.range.clone()),
            |select, (value, label)| select.option(*value, *label),
        );
        let range = range.on_change(move |value, _, cx| {
            let value = SharedString::from(value.to_string());
            pick.update(cx, |this, cx| {
                this.range = value;
                cx.notify();
            });
        });
        let toggle = me.clone();
        let only = Stack::row()
            .cross(Cross::Center)
            .justify(Justify::Between)
            .gap(Space::Sm)
            .child(Typo::body(copy.butler_only))
            .child(
                Switch::new("history-clear-only")
                    .checked(self.only)
                    .on_checked_change(move |checked, _, cx| {
                        toggle.update(cx, |this, cx| {
                            this.only = checked;
                            cx.notify();
                        });
                    }),
            );
        let (cancel, remove) = (me.clone(), me);
        let footer = DialogFooter::new()
            .child(disabled_if(
                Button::new("history-clear-cancel")
                    .size(Size::Sm)
                    .variant(Variant::Ghost)
                    .text(copy.cancel)
                    .on_click(move |_, _, cx| {
                        cancel.update(cx, Self::close);
                    }),
                self.busy,
            ))
            .child(disabled_if(
                Button::new("history-clear-remove")
                    .size(Size::Sm)
                    .text(copy.remove)
                    .on_click(move |_, _, cx| {
                        remove.update(cx, Self::clear);
                    }),
                self.busy,
            ));
        let content = DialogContent::new()
            .header(DialogHeader::new().child(DialogTitle::new(copy.clear)))
            .child(Stack::new().gap(Space::Md).child(range).child(only))
            .footer(footer);
        div().child(dialog.content(content, window, cx))
    }
}
