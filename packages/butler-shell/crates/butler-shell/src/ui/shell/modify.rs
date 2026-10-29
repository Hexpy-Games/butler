//! The suggest-a-change dialog: from an authority card, the owner writes how Butler should do
//! it instead, and the request is answered with that instruction (the client's `modify`). The
//! dialog sits over the chat card above a veil (its glass samples, and refracts, the dimmed
//! content); a click outside closes it, and wheel scrolling over it moves the chat behind.
use gpui::{
    AnyElement, AppContext as _, Bounds, Context, Entity, MouseButton, Pixels, ScrollWheelEvent,
    Window, div, prelude::*, px,
};

use super::Shell;
use crate::ui::composer::input_colors;
use crate::ui::dialog::{Activated, Dialog, DialogSpec};
use crate::ui::glass;
use crate::ui::input::TextInput;
use crate::ui::source::{AuthorityCard, Decision};
use crate::ui::theme::{Theme, alpha};

/// The dialog's bottom sits this far above the composer's top.
const ABOVE_COMPOSER: f32 = 110.;
/// The gateway accepts instructions up to 16 KB.
const MAX_INSTRUCTION: usize = 16 * 1024;

/// The dialog body: the request's exact action, then the instruction field.
fn body(action: gpui::SharedString, input: Entity<TextInput>) -> crate::ui::dialog::Body {
    Box::new(move |t: &Theme, s: f32| {
        let field = div()
            .mt(px(14. * s))
            .px(px(12. * s))
            .py(px(10. * s))
            .rounded(px(12. * s))
            .border_1()
            .border_color(t.line_strong)
            .bg(alpha(t.surface, 0.6))
            .text_size(px(14.))
            .line_height(px(20.))
            .child(input.clone());
        div()
            .flex()
            .flex_col()
            .child(crate::ui::exact_action::exact_action(action.clone(), t, s))
            .child(field)
            .into_any_element()
    })
}

impl Shell {
    /// Opens the dialog for `card`.
    pub(crate) fn open_modify(
        &mut self,
        card: &AuthorityCard,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let t = self.theme.clone();
        let s = t.strings;
        let input = cx.new(|cx| TextInput::new(s.modify_placeholder, input_colors(&t), cx));
        let action = card
            .approval
            .as_ref()
            .and_then(crate::ui::source::Approval::action);
        let spec = DialogSpec {
            title: s.modify.into(),
            leading: None,
            trailing: vec![("close", "x")],
            body: body(action.unwrap_or_else(|| card.reason.clone()), input.clone()),
            actions: vec![
                ("cancel", s.cancel, false),
                ("submit", s.submit_modify, true),
            ],
            size: (520., 250.),
        };
        let dialog = cx.new(|cx| Dialog::new(spec, t, cx));
        let request = card.request.clone();
        let field = input.clone();
        let sub = cx.subscribe(
            &dialog,
            move |this: &mut Self, dialog, Activated(key), cx| {
                let instruction = field.read(cx).text().trim().to_owned();
                if *key == "submit" {
                    if instruction.is_empty() || instruction.len() > MAX_INSTRUCTION {
                        return;
                    }
                    this.answer(&request, Decision::Modify(instruction), cx);
                }
                dialog.update(cx, super::super::dialog::Dialog::close);
                cx.notify();
            },
        );
        self.subscriptions.push(sub);
        self.dialog = Some(dialog);
        window.focus(&input.read(cx).focus_handle.clone(), cx);
        cx.notify();
    }

    pub(super) fn close_dialog(&mut self, cx: &mut Context<Self>) {
        if let Some(dialog) = &self.dialog {
            dialog.update(cx, super::super::dialog::Dialog::close);
        }
        cx.notify();
    }

    fn wheel_to_chat(&mut self, e: &ScrollWheelEvent, window: &mut Window, cx: &mut Context<Self>) {
        self.chat
            .update(cx, |c, cx| c.wheel_from_overlay(e, window, cx));
        cx.stop_propagation();
    }

    /// The veil and the dialog, laid over `card` (empty when no dialog is open).
    pub(super) fn render_dialog(
        &mut self,
        card: Bounds<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        let Some(dialog) = self.dialog.clone() else {
            return Vec::new();
        };
        let now = cx.background_executor().now();
        let ((v, moving), (mw, mh)) = {
            let d = dialog.read(cx);
            (d.amount(now), d.size())
        };
        if moving {
            window.request_animation_frame();
        }
        if v <= 0. && !moving {
            self.dialog = None;
            return Vec::new();
        }
        let scrim = div()
            .id("dialog-scrim")
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .bg(alpha(glass::veil(self.theme.dark), v))
            .occlude()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, _, cx| this.close_dialog(cx)),
            )
            .on_scroll_wheel(cx.listener(Self::wheel_to_chat));
        let composer_top = card.bottom().as_f32() - 22. - self.composer_h.get();
        let left0 = card.center().x.as_f32() - mw / 2.;
        let top0 = (composer_top - ABOVE_COMPOSER - mh).max(card.top().as_f32() + 16.);
        let s = 0.94 + 0.06 * v;
        let (w, h) = (mw * s, mh * s);
        let frame = div()
            .id("dialog-frame")
            .absolute()
            .left(px(left0 + (mw - w) / 2.))
            .top(px(top0 + (mh - h) / 2.))
            .w(px(w))
            .h(px(h))
            .on_scroll_wheel(cx.listener(Self::wheel_to_chat))
            .child(dialog);
        vec![scrim.into_any_element(), frame.into_any_element()]
    }
}
