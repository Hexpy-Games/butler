//! The composer's toolbar: attach, permission and model pills, the send/stop button, and the
//! folded one-line preview.
use gpui::{AnimationExt as _, Context, FontWeight, Hsla, SharedString, div, prelude::*, px};

use super::{Composer, ComposerEvent, Submit};
use crate::motion::{mix, spring_fast};
use crate::theme::{alpha, rgba, typo};
use crate::widgets::{IconButtonSpec, hover_listener, icon, icon_button, text, tooltip};

/// A pill's label: text, an optional secondary detail and an optional leading glyph.
struct Pill {
    id: &'static str,
    glyph: Option<(&'static str, Hsla)>,
    label: SharedString,
    detail: Option<SharedString>,
}

impl Composer {
    fn pill(&self, pill: Pill, cx: &mut Context<Self>) -> impl IntoElement {
        let t = &self.theme;
        let key = SharedString::from(pill.id);
        let on = t.selection;
        let off = Hsla { alpha: 0., ..on };
        let mut row = div().flex().items_center().gap(px(4.)).child(text(
            pill.label,
            typo::CAPTION,
            FontWeight::NORMAL,
            t.text,
        ));
        if let Some(d) = pill.detail {
            row = row.child(text(d, typo::CAPTION, FontWeight::NORMAL, t.text3));
        }
        let pad_right = if pill.glyph.is_some() { 14. } else { 10. };
        let mut el = div()
            .id(key.clone())
            .h(px(30.))
            .flex()
            .flex_none()
            .items_center()
            .gap(px(5.))
            .pl(px(10.))
            .pr(px(pad_right))
            .rounded_full()
            .cursor_pointer()
            .on_hover(hover_listener(&key, cx));
        if let Some((name, color)) = pill.glyph {
            el = el.child(icon(name, 16., color));
        }
        let lit = self.hover.is(pill.id);
        el.child(row)
            .with_spring(key, spring_fast(lit), move |el, v| el.bg(mix(off, on, v)))
    }

    fn send_button(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let t = &self.theme;
        let empty = self.input.read(cx).content.trim().is_empty();
        let disabled = self.disabled.clone();
        let (bg, glyph, size) = if self.streaming {
            let stop = if t.dark {
                rgba(232, 233, 235, 1.)
            } else {
                rgba(31, 32, 35, 1.)
            };
            (stop, "square", 14.)
        } else if empty || disabled.is_some() {
            (alpha(t.send_disabled, 0.56), "send", 16.)
        } else {
            (t.send_bg, "send", 16.)
        };
        let button = div()
            .id("send")
            .size(px(30.))
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .rounded_full()
            .bg(bg)
            .child(icon(glyph, size, t.send_fg));
        if let Some(reason) = disabled {
            return button.tooltip(tooltip(reason, t)).into_any_element();
        }
        button
            .when(!empty || self.streaming, gpui::Styled::cursor_pointer)
            .on_click(cx.listener(|this, _, window, cx| {
                if this.streaming {
                    cx.emit(ComposerEvent::Stop);
                } else {
                    this.submit(&Submit, window, cx);
                }
            }))
            .into_any_element()
    }

    fn context_pills(&self, cx: &mut Context<Self>) -> Vec<gpui::AnyElement> {
        let Some(context) = self.context.clone() else {
            return Vec::new();
        };
        let access = Pill {
            id: "access",
            glyph: Some(("shield-question", self.theme.accent_text)),
            label: context.permission,
            detail: None,
        };
        let model = Pill {
            id: "model",
            glyph: None,
            label: context.model,
            detail: Some(context.effort),
        };
        vec![
            self.pill(access, cx).into_any_element(),
            div().flex_1().min_w(px(8.)).into_any_element(),
            self.pill(model, cx).into_any_element(),
        ]
    }

    fn preview(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let t = &self.theme;
        let input = self.input.read(cx);
        let draft = input.text();
        let (s, c) = if draft.is_empty() {
            (input.placeholder.clone(), t.placeholder)
        } else {
            (draft, t.text)
        };
        let preview = div()
            .id("compact-preview")
            .flex_1()
            .min_w_0()
            .px(px(8.))
            .child(text(s, typo::BODY, FontWeight::NORMAL, c).truncate());
        match self.disabled.clone() {
            Some(reason) => preview.tooltip(tooltip(reason, t)),
            None => preview
                .cursor_text()
                .on_click(cx.listener(|this, _, window, cx| this.engage(window, cx))),
        }
    }

    pub(super) fn toolbar(&mut self, cx: &mut Context<Self>) -> impl IntoElement {
        let t = self.theme.clone();
        let plus = IconButtonSpec::new("plus", "plus", self.hover.is("plus"))
            .disabled(self.disabled.clone());
        let plus = icon_button(&t, plus, hover_listener(&"plus".into(), cx), |_, _, _| {});
        let divider = if self.engaged {
            t.glass_divider
        } else {
            gpui::transparent_black()
        };
        let bar = div()
            .flex()
            .items_center()
            .gap(px(4.))
            .min_h(px(if self.engaged { 42. } else { 38. }))
            .p(px(8.))
            .border_t_1()
            .border_color(divider)
            .child(plus);
        if self.engaged {
            return bar
                .children(self.context_pills(cx))
                .child(self.send_button(cx));
        }
        let streaming = self.streaming;
        bar.child(self.preview(cx))
            .when(streaming, |b| b.child(self.send_button(cx)))
    }
}
