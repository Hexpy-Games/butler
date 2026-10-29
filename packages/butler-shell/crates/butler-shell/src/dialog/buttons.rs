//! The dialog's buttons. Native press: while held a control grows (round: 1.5 pt per side;
//! text: 1.5 pt left and right, 1 pt top and bottom) about its centre and its fill lightens,
//! eased in over 120 ms and back on release. The layout box stays put and the glass or fill
//! grows in float at paint (exact bounds), so neighbours never move and the edge moves by
//! fractions of a pixel; labels and icons keep their rest size and place (gpui snaps glyph
//! rasters to pixels, so scaling them per frame would jitter).
use gpui::{Context, FontWeight, MouseButton, SharedString, Stateful, canvas, div, prelude::*, px};

use super::{BUTTON, Dialog};
use crate::glass::{self, Native};
use crate::widgets::{hover_listener, icon, text};

impl Dialog {
    /// A pressable control: starts the press on mouse down and records its bounds.
    fn pressable(
        &self,
        key: &'static str,
        el: Stateful<gpui::Div>,
        cx: &mut Context<Self>,
    ) -> Stateful<gpui::Div> {
        let probe = self.presses.probe(key.into());
        el.on_mouse_down(
            MouseButton::Left,
            cx.listener(move |this, _, _, cx| {
                if this
                    .presses
                    .start(key.into(), cx.background_executor().now())
                {
                    cx.notify();
                }
            }),
        )
        .child(probe)
    }

    /// A round glass button on the dialog's glass (its own rim, hairline and lighter fill).
    pub(super) fn round_button(
        &self,
        key: &'static str,
        glyph: &'static str,
        size: f32,
        cx: &mut Context<Self>,
    ) -> Stateful<gpui::Div> {
        let t = &self.theme;
        let hovered = self.hover.is(key);
        let p = self.presses.amount(key, cx.background_executor().now());
        // Native fill change on press: +8 levels light, +16 dark (regular circle over grey).
        let lift = p * if t.dark { 0.063 } else { 0.031 } + if hovered { 0.012 } else { 0. };
        let face = div()
            .absolute()
            .top_0()
            .left_0()
            .size(px(size))
            .flex()
            .items_center()
            .justify_center()
            .child(glass::layer(t, size / 2., Native::on_glass(lift, 1.5 * p)))
            .child(icon(glyph, 18. * size / BUTTON, t.text));
        let key_str: SharedString = key.into();
        let el = div()
            .id(key)
            .relative()
            .size(px(size))
            .flex_none()
            .cursor_pointer()
            .on_hover(hover_listener(&key_str, cx));
        self.pressable(key, el, cx).child(face)
    }

    /// A text button: at rest the DS quad; while pressed a float-geometry fill.
    fn text_button(
        &self,
        key: &'static str,
        label: &'static str,
        primary: bool,
        s: f32,
        cx: &mut Context<Self>,
    ) -> Stateful<gpui::Div> {
        let t = &self.theme;
        let p = self.presses.amount(key, cx.background_executor().now());
        let fg = if primary { t.send_fg } else { t.text };
        let bg = if primary { t.send_bg } else { t.secondary_bg };
        let (border, radius) = (t.secondary_border, 10. * s);
        let grow = (1.5 * p, 1.0 * p);
        let fill = canvas(
            |_, _, _| (),
            move |b, (), window, _| {
                let c = gpui::hsla_to_rgba(bg);
                let grey = 0.2126 * c.red + 0.7152 * c.green + 0.0722 * c.blue;
                glass::paint_fill(b, radius, grey + (1. - grey) * 0.12 * p, grow, window);
            },
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full();
        let role = (14. * s, 20. * s);
        let face = div()
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .when(p <= 0., |d| {
                d.rounded(px(radius))
                    .bg(bg)
                    .when(!primary, |d| d.border_1().border_color(border))
            })
            .when(p > 0., |d| d.child(fill))
            .child(text(label, role, FontWeight::MEDIUM, fg));
        let el = div()
            .id(key)
            .relative()
            .h(px(36. * s))
            .px(px(16. * s))
            .flex()
            .items_center()
            .cursor_pointer()
            // An invisible copy of the label sizes the button.
            .child(text(
                label,
                role,
                FontWeight::MEDIUM,
                gpui::transparent_black(),
            ))
            .child(face);
        self.pressable(key, el, cx)
    }

    pub(super) fn footer(&self, s: f32, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let mut footer = div()
            .absolute()
            .right(px(20. * s))
            .bottom(px(18. * s))
            .flex()
            .gap(px(8. * s));
        for (key, label, primary) in self.spec.actions.clone() {
            footer = footer.child(self.text_button(key, label, primary, s, cx));
        }
        footer
    }
}
