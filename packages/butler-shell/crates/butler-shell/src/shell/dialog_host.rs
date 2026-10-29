//! Hosting a [`Dialog`]: the veil under it (the dialog's glass samples, and refracts, the
//! dimmed content), its place over the chat card, closing on a click outside or any of its
//! buttons, and wheel scrolling over it moving the chat behind.
use gpui::{
    AnyElement, AppContext as _, Bounds, Context, MouseButton, Pixels, ScrollWheelEvent, Window,
    div, prelude::*, px,
};

use super::Shell;
use crate::dialog::{Activated, Dialog, DialogSpec};
use crate::glass;
use crate::theme::alpha;

/// The dialog's bottom sits this far above the composer's top.
const ABOVE_COMPOSER: f32 = 110.;

impl Shell {
    /// Opens `spec` over the chat card.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the first product dialog lands with schedules")
    )]
    pub(crate) fn open_dialog(&mut self, spec: DialogSpec, cx: &mut Context<Self>) {
        let theme = self.theme.clone();
        let dialog = cx.new(|cx| Dialog::new(spec, theme, cx));
        let sub = cx.subscribe(&dialog, |_: &mut Self, dialog, _: &Activated, cx| {
            dialog.update(cx, super::super::dialog::Dialog::close);
            cx.notify();
        });
        self.subscriptions.push(sub);
        self.dialog = Some(dialog);
        cx.notify();
    }

    fn close_dialog(&mut self, cx: &mut Context<Self>) {
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
        let veil = glass::veil(self.theme.dark);
        let scrim = div()
            .id("dialog-scrim")
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .bg(alpha(veil, v))
            .occlude()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, _, cx| this.close_dialog(cx)),
            )
            .on_scroll_wheel(cx.listener(Self::wheel_to_chat));
        let composer_top = card.bottom().as_f32() - 22. - self.composer_h;
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
