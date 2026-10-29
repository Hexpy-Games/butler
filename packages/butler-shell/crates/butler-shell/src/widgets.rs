//! Small DS primitives: Icon, IconButton, text roles, tooltips, hover listeners.
use gpui::{
    AnimationExt as _, AnyView, App, ClickEvent, Context, Div, FontWeight, Hsla, IntoElement,
    Render, SharedString, Svg, Window, WindowControlArea, div, prelude::*, px, svg,
};

use crate::motion::{Hover, mix, spring_fast};
use crate::theme::{Theme, typo};

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

pub(crate) fn icon(name: &str, size: f32, color: Hsla) -> Svg {
    svg()
        .path(SharedString::from(format!("icons/{name}.svg")))
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

pub(crate) struct IconButtonSpec {
    pub(crate) id: SharedString,
    pub(crate) icon: &'static str,
    pub(crate) size: f32,
    pub(crate) icon_size: f32,
    pub(crate) hovered: bool,
    /// Why the button is disabled (shown as its tooltip); None when enabled.
    pub(crate) disabled: Option<SharedString>,
    /// Windows caption-button hit area (min/max/close), handled natively by gpui.
    pub(crate) control: Option<WindowControlArea>,
}

impl IconButtonSpec {
    pub(crate) fn new(id: impl Into<SharedString>, icon: &'static str, hovered: bool) -> Self {
        Self {
            id: id.into(),
            icon,
            size: 30.,
            icon_size: 16.,
            hovered,
            disabled: None,
            control: None,
        }
    }

    pub(crate) fn size(mut self, size: f32, icon_size: f32) -> Self {
        self.size = size;
        self.icon_size = icon_size;
        self
    }

    pub(crate) fn disabled(mut self, reason: Option<SharedString>) -> Self {
        self.disabled = reason;
        self
    }
}

/// DS IconButton: 30px pill, secondary glyph; hover fills --selection and lifts the glyph to
/// primary on --motion-fast. Disabled: a muted glyph, no hover, and the reason as a tooltip.
pub(crate) fn icon_button(
    theme: &Theme,
    spec: IconButtonSpec,
    on_hover: impl Fn(&bool, &mut Window, &mut App) + 'static,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> impl IntoElement {
    let lit = spec.hovered && spec.disabled.is_none();
    let (bg_on, fg_off, fg_on) = (theme.selection, theme.text2, theme.text);
    let bg_off = Hsla { alpha: 0., ..bg_on };
    let (name, icon_size) = (spec.icon, spec.icon_size);
    let mut el = div()
        .id(spec.id.clone())
        .size(px(spec.size))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded_full()
        .on_hover(on_hover);
    if let Some(area) = spec.control {
        el = el.window_control_area(area);
    }
    if let Some(reason) = spec.disabled {
        return el
            .tooltip(tooltip(reason, theme))
            .child(icon(name, icon_size, theme.text3))
            .into_any_element();
    }
    el.cursor_pointer()
        .on_click(on_click)
        .with_spring(spec.id, spring_fast(lit), move |el, t| {
            el.bg(mix(bg_off, bg_on, t))
                .child(icon(name, icon_size, mix(fg_off, fg_on, t)))
        })
        .into_any_element()
}
