//! DS GlyphToggle (GlyphToggle.tsx / GlyphToggle.module.css): a row glyph that doubles as a
//! toggle. It keeps the glyph's column width, shows the toggle glyph on hover and keyboard
//! focus, keeps a full hit target and rings the visible icon surface, not the target.
use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, ElementId, InteractiveElement as _, IntoElement,
    ParentElement as _, RenderOnce, SharedString, StatefulInteractiveElement as _, Styled as _,
    Window, div, px,
};

use super::context::{Ds, Modality};
use super::icon_button::IconButton;
use crate::tokens::{Color, Length};

type Handler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct GlyphToggle {
    id: ElementId,
    glyph: Option<AnyElement>,
    toggle_glyph: Option<AnyElement>,
    pressed: bool,
    label: SharedString,
    on_click: Option<Handler>,
}

impl GlyphToggle {
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>, pressed: bool) -> Self {
        Self {
            id: id.into(),
            glyph: None,
            toggle_glyph: None,
            pressed,
            label: label.into(),
            on_click: None,
        }
    }

    /// The row glyph shown at rest.
    pub fn glyph(mut self, glyph: impl IntoElement) -> Self {
        self.glyph = Some(glyph.into_any_element());
        self
    }

    /// The glyph shown on hover and keyboard focus.
    pub fn toggle_glyph(mut self, glyph: impl IntoElement) -> Self {
        self.toggle_glyph = Some(glyph.into_any_element());
        self
    }

    pub fn on_click(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for GlyphToggle {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let hover = window.use_keyed_state((self.id.clone(), "hover"), cx, |_, _| false);
        let handle = window
            .use_keyed_state((self.id.clone(), "focus-probe"), cx, |_, cx| {
                cx.focus_handle()
            })
            .read(cx)
            .clone();
        let ds = Ds::get(cx);
        // `--sidebar-icon-size` and `--sidebar-icon-surface-size` are set by the sidebar only; elsewhere
        // the fallbacks apply: the md icon size and the hit target.
        let slot = ds.len(Length::IconSizeMd);
        let hit = ds.len(if ds.compact() {
            Length::ControlHitTarget
        } else {
            Length::ControlHeightMd
        });
        let surface = hit;
        // `(--sidebar-icon-surface-size - --control-hit-target) / 2 + room - ring width`.
        let offset = (f32::from(surface) - f32::from(hit)) / 2.
            + f32::from(ds.len(Length::FocusRingRoom))
            - f32::from(ds.len(Length::FocusRingWidth));
        let showing = *hover.read(cx)
            || (handle.contains_focused(window, cx) && ds.modality() == Modality::Keyboard);
        let glyph = |content: Option<AnyElement>, visible: bool| {
            div()
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .flex()
                .items_center()
                .justify_center()
                .opacity(if visible { 1. } else { 0. })
                .children(content)
        };
        let cell = div()
            .relative()
            .size(slot)
            .child(glyph(self.glyph, !showing))
            .child(glyph(self.toggle_glyph, showing));
        let mut button = IconButton::new((self.id.clone(), "toggle"), self.label)
            .icon(cell)
            .pressed(self.pressed)
            .inherit_color(ds.color(Color::TextPrimary))
            .focus_outline(offset);
        if let Some(handler) = self.on_click {
            button = button.on_click(move |event, window, cx| handler(event, window, cx));
        }
        let hover_state = hover.clone();
        // The toggle is centred on the glyph column: `top: 50%; left: 50%; translate: -50% -50%`.
        let half = f32::from(hit) / 2.;
        let host = div()
            .id((self.id.clone(), "host"))
            .absolute()
            .top(px(f32::from(slot) / 2. - half))
            .left(px(f32::from(slot) / 2. - half))
            .track_focus(&handle)
            .tab_stop(false)
            .on_hover(move |on, _, cx| {
                hover_state.update(cx, |h, cx| {
                    *h = *on;
                    cx.notify();
                });
            })
            .child(button);
        div().relative().flex_none().size(slot).child(host)
    }
}
