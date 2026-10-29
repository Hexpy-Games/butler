//! The composer's toolbar: attach, the permission and model labels, the send/stop button,
//! and the folded one-line preview. Controls this build cannot use yet are disabled with a
//! tooltip; while no agent is attached the whole composer is.
use gpui::{AnyElement, Context, FontWeight, Hsla, SharedString, div, prelude::*, px};

use super::{Composer, ComposerEvent, Submit};
use crate::ui::theme::{alpha, rgba, typo};
use crate::ui::widgets::{IconButtonSpec, hover_listener, icon, icon_button, text, tooltip};

/// A label pill: text, an optional secondary detail and an optional leading glyph.
struct Pill {
    id: &'static str,
    unavailable: bool,
    glyph: Option<(&'static str, Hsla)>,
    label: SharedString,
    detail: Option<SharedString>,
}

impl Composer {
    /// The permission and model labels. Changing them comes later: they say so on hover.
    fn pill(&self, pill: Pill) -> impl IntoElement {
        let t = &self.theme;
        let unavailable = pill.unavailable;
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
        div()
            .id(pill.id)
            .h(px(30.))
            .flex()
            .flex_none()
            .items_center()
            .gap(px(5.))
            .pl(px(10.))
            .pr(px(pad_right))
            .rounded_full()
            .tooltip(tooltip(
                if unavailable {
                    t.strings.load_failed
                } else {
                    t.strings.not_yet
                },
                t,
            ))
            .children(pill.glyph.map(|(name, color)| icon(name, 16., color)))
            .child(row)
    }

    fn send_button(&self, cx: &mut Context<Self>) -> AnyElement {
        let t = &self.theme;
        let empty = self.input.read(cx).content.trim().is_empty();
        let (bg, glyph, size) = if self.streaming {
            let stop = if t.dark {
                rgba(232, 233, 235, 1.)
            } else {
                rgba(31, 32, 35, 1.)
            };
            (stop, "square", 14.)
        } else if empty || self.disabled.is_some() {
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
        if let Some(reason) = self.disabled.clone() {
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

    fn context_pills(&self) -> Vec<AnyElement> {
        let Some(context) = self.context.clone() else {
            return Vec::new();
        };
        let unavailable = context.state == crate::ui::source::model::Controls::Unavailable;
        let access = Pill {
            unavailable,
            id: "access",
            glyph: Some(("shield-question", self.theme.accent_text)),
            label: self.theme.strings.control_label(&context.permission),
            detail: None,
        };
        let model = Pill {
            unavailable,
            id: "model",
            glyph: None,
            label: if unavailable {
                "—".into()
            } else {
                context.model
            },
            detail: (!unavailable).then(|| self.theme.strings.control_label(&context.effort)),
        };
        vec![
            self.pill(access).into_any_element(),
            div().flex_1().min_w(px(8.)).into_any_element(),
            self.pill(model).into_any_element(),
        ]
    }

    /// The folded composer's one line: the draft or the placeholder. Disabled, it takes the
    /// disabled text colour and no text cursor, and says why on hover.
    fn preview(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let t = &self.theme;
        let input = self.input.read(cx);
        let draft = input.text();
        let color = match (self.disabled.is_some(), draft.is_empty()) {
            (true, _) => t.text_disabled,
            (false, true) => t.placeholder,
            (false, false) => t.text,
        };
        let line = if draft.is_empty() {
            input.placeholder.clone()
        } else {
            draft
        };
        let preview = div()
            .id("compact-preview")
            .flex_1()
            .min_w_0()
            .px(px(8.))
            .child(text(line, typo::BODY, FontWeight::NORMAL, color).truncate());
        match self.disabled.clone() {
            Some(reason) => preview.tooltip(tooltip(reason, t)),
            None => preview
                .cursor_text()
                .on_click(cx.listener(|this, _, window, cx| this.engage(window, cx))),
        }
    }

    pub(super) fn toolbar(&mut self, cx: &mut Context<Self>) -> impl IntoElement {
        let t = self.theme.clone();
        let attach_off = self
            .disabled
            .clone()
            .unwrap_or_else(|| t.strings.not_yet.into());
        let plus = IconButtonSpec::new("plus", "plus", false).disabled(Some(attach_off));
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
                .children(self.context_pills())
                .child(self.send_button(cx));
        }
        let streaming = self.streaming;
        bar.child(self.preview(cx))
            .when(streaming, |b| b.child(self.send_button(cx)))
    }
}
