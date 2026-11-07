//! Small DS primitives: Icon, IconButton, text roles, tooltips, hover listeners.
use gpui::{
    AnyView, App, Context, Div, FontWeight, Hsla, IntoElement, Render, SharedString, Svg, Window,
    div, prelude::*, px, svg,
};

use crate::ui::Icon;
use crate::ui::motion::Hover;
use crate::ui::theme::{Theme, typo};

pub(crate) trait HasHover {
    fn hover_state(&mut self) -> &mut Hover;
}

/// An `on_hover` listener that records the hovered key on the entity and re-renders it.
pub(crate) fn hover_listener<T: HasHover + 'static>(
    key: &SharedString,
    cx: &mut Context<T>,
) -> impl Fn(&bool, &mut Window, &mut App) + 'static {
    let key = key.clone();
    cx.listener(move |this: &mut T, on: &bool, _, cx| {
        if this.hover_state().set(&key, *on) {
            cx.notify();
        }
    })
}

pub(crate) fn icon(icon: Icon, size: f32, color: Hsla) -> Svg {
    svg()
        .path(SharedString::from(icon.path()))
        .size(px(size))
        .flex_none()
        .text_color(color)
}

/// A text run in one of Butler's integer line-height roles.
pub(crate) fn text(
    s: impl Into<SharedString>,
    role: (f32, f32),
    weight: FontWeight,
    color: Hsla,
) -> Div {
    div()
        .text_size(px(role.0))
        .line_height(px(role.1))
        .font_weight(weight)
        .text_color(color)
        .child(s.into())
}

/// The DS tooltip: a small raised label (disabled controls say why they are disabled).
pub(crate) struct Tooltip {
    text: SharedString,
    theme: Theme,
}

impl Render for Tooltip {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let t = &self.theme;
        div()
            .px(px(8.))
            .py(px(4.))
            .rounded(px(6.))
            .bg(t.surface_raised)
            .border_1()
            .border_color(t.line)
            .shadow(vec![t.glass_shadow.clone()])
            .child(text(
                self.text.clone(),
                typo::CAPTION,
                FontWeight::NORMAL,
                t.text,
            ))
    }
}

/// A `.tooltip(..)` builder showing `label`.
pub(crate) fn tooltip(
    label: impl Into<SharedString>,
    theme: &Theme,
) -> impl Fn(&mut Window, &mut App) -> AnyView + 'static {
    let (label, theme) = (label.into(), theme.clone());
    move |_, cx| {
        let (text, theme) = (label.clone(), theme.clone());
        cx.new(|_| Tooltip { text, theme }).into()
    }
}

/// Stable geometry selector for the screenshot harness.
pub(crate) fn anchor<E: InteractiveElement>(el: E, name: &str) -> E {
    #[cfg(feature = "shots")]
    {
        el.debug_selector(|| name.to_owned())
    }
    #[cfg(not(feature = "shots"))]
    {
        let _ = name;
        el
    }
}
