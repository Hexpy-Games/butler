//! Browser history (`BrowserHistorySection.tsx`, `HistoryClearDialog.tsx`).
mod copy;

use butler_ds::ui::blocks::settings_action_field::SettingsActionField;
use butler_ds::ui::blocks::settings_section::{SettingsSection, SettingsSectionKind};
use butler_ds::ui::button::{self, Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::dialog::{Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle};
use butler_ds::ui::layout::{Cross, Justify, Space, Stack};
use butler_ds::ui::native_select::NativeSelect;
use butler_ds::ui::switch::Switch;
use butler_ds::ui::toast::{self, Toast};
use butler_ds::ui::typo::Typo;
use butler_shell_client::Error;
use gpui::{
    AnyElement, Context, InteractiveElement as _, ParentElement as _, SharedString, Window, div,
};
use serde_json::{Value, json};

use crate::ui::settings::SectionCtx;
use crate::ui::settings::state::fetch;
use crate::ui::widgets::anchor;
use copy::words;

/// The clear dialog's form (`range`, `only`, `busy`).
struct Clear {
    range: SharedString,
    only: bool,
    busy: bool,
}

/// `BrowserHistorySection`
pub(super) struct BrowserHistory {
    ctx: SectionCtx,
    clear: Option<Clear>,
}

impl BrowserHistory {
    pub(super) fn new(ctx: &SectionCtx) -> Self {
        Self {
            ctx: ctx.clone(),
            clear: None,
        }
    }

    pub(super) fn section(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> SettingsSection {
        let copy = words(Ds::get(cx).lang());
        let me = cx.entity();
        // `openHistory("settings")`: Settings closes and the history page shows.
        let ctx = self.ctx.clone();
        let view = anchor(
            div().id("browser-history-view-anchor").child(
                Button::new("browser-history-view")
                    .size(Size::Sm)
                    .variant(Variant::Outline)
                    .text(copy.view)
                    .on_click(move |_, _, cx| ctx.open_history(cx)),
            ),
            "browser-history-view",
        );
        let erase = Button::new("browser-history-erase")
            .size(Size::Sm)
            .variant(Variant::Outline)
            .text(copy.erase)
            .on_click(move |_, _, cx| {
                me.update(cx, |this, cx| {
                    this.clear = Some(Clear {
                        range: "hour".into(),
                        only: false,
                        busy: false,
                    });
                    cx.notify();
                });
            });
        let action = button::container(Size::Sm).child(view).child(erase);
        let field = SettingsActionField::new(copy.label, copy.description, action)
            .setting_id("browser-history");
        SettingsSection::new("browser-history", SettingsSectionKind::Form, copy.title)
            .child(field)
            .children(self.dialog(window, cx))
    }

    fn close(&mut self, cx: &mut Context<Self>) {
        if self.clear.as_ref().is_some_and(|clear| !clear.busy) {
            self.clear = None;
            cx.notify();
        }
    }

    /// `clear()`: POST /browser-history/clear.
    fn erase(&mut self, cx: &mut Context<Self>) {
        let Some(form) = self.clear.as_mut() else {
            return;
        };
        form.busy = true;
        let body = json!({ "range": form.range.to_string(), "butlerOnly": form.only });
        cx.notify();
        fetch(
            cx,
            move |client| async move { client.clear_browser_history(&body).await },
            |this: &mut Self, result: Result<Value, Error>, cx| match result {
                Ok(_) => this.clear = None,
                Err(_) => {
                    if let Some(form) = this.clear.as_mut() {
                        form.busy = false;
                    }
                    let copy = words(Ds::get(cx).lang());
                    toast::show(cx, Toast::error(copy.failed));
                }
            },
        );
    }

    fn dialog(&self, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let form = self.clear.as_ref()?;
        let copy = words(Ds::get(cx).lang());
        let me = cx.entity();
        let dismiss = me.clone();
        let dialog = Dialog::new("browser-history-clear", window, cx)
            .open(true)
            .on_open_change(move |open, _, cx| {
                if !open {
                    dismiss.update(cx, BrowserHistory::close);
                }
            });
        let range = copy.ranges.iter().fold(
            NativeSelect::new("browser-history-range").value(form.range.clone()),
            |select, (value, label)| select.option(*value, *label),
        );
        let pick = me.clone();
        let range = range.on_change(move |value, _, cx| {
            let value = SharedString::from(value.to_string());
            pick.update(cx, |this, cx| {
                if let Some(form) = this.clear.as_mut() {
                    form.range = value;
                    cx.notify();
                }
            });
        });
        let toggle = me.clone();
        let only = Stack::row()
            .cross(Cross::Center)
            .justify(Justify::Between)
            .gap(Space::Sm)
            .child(Typo::body(copy.butler_only))
            .child(
                Switch::new("browser-history-only")
                    .checked(form.only)
                    .on_checked_change(move |checked, _, cx| {
                        toggle.update(cx, |this, cx| {
                            if let Some(form) = this.clear.as_mut() {
                                form.only = checked;
                                cx.notify();
                            }
                        });
                    }),
            );
        let busy = form.busy;
        let (cancel, remove) = (me.clone(), me);
        let footer = DialogFooter::new()
            .child(disabled_if(
                Button::new("browser-history-cancel")
                    .size(Size::Sm)
                    .variant(Variant::Ghost)
                    .text(copy.cancel)
                    .on_click(move |_, _, cx| {
                        cancel.update(cx, BrowserHistory::close);
                    }),
                busy,
            ))
            .child(disabled_if(
                Button::new("browser-history-remove")
                    .size(Size::Sm)
                    .text(copy.remove)
                    .on_click(move |_, _, cx| {
                        remove.update(cx, BrowserHistory::erase);
                    }),
                busy,
            ));
        let content = DialogContent::new()
            .header(DialogHeader::new().child(DialogTitle::new(copy.clear)))
            .child(Stack::new().gap(Space::Md).child(range).child(only))
            .footer(footer);
        Some(dialog.content(content, window, cx))
    }
}

fn disabled_if(button: Button, disabled: bool) -> Button {
    if disabled { button.disabled() } else { button }
}
