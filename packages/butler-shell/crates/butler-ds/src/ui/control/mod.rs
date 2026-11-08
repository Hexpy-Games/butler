//! The pointer-control core Button, IconButton, PillButton, Clickable and GlyphToggle share:
//! hover fills that fade over `--motion-fast`, the press-in at `--motion-instant`, the keyboard
//! focus ring, the two disabled families and the click gate of `aria-disabled` (card sections
//! 0.2 to 0.4). Components pick the colours and sizes; this draws and tracks them.
//!
//! The press `scale` is gpui's element scale about the centre: the whole control, content
//! included, shrinks over `--motion-instant` and is released over `--motion-fast`.
use std::rc::Rc;

use gpui::{
    AnyElement, App, BoxShadow, ClickEvent, Div, ElementId, Hsla, InteractiveElement as _,
    IntoElement, MouseButton, ParentElement as _, Pixels, RenderOnce, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window, div, px,
};

use super::context::Ds;
use super::convert;
use super::focus;
use crate::tokens::{Color, Duration as DsDuration, Easing, Number};

pub(crate) type Handler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;
/// A final restyle of the outer element (margins, translate).
pub(crate) type Outer = Box<dyn FnOnce(gpui::Stateful<Div>) -> gpui::Stateful<Div>>;

mod parts;

use parts::State;
pub use parts::{
    Blend, Disabled, DisabledLook, Ring, Underline, Width, focus_handle, over, reset_anchors,
};
pub(crate) use parts::{State as Glide, next_anchor};

/// A control being built: geometry and colours resolved by its component.
#[expect(
    clippy::struct_excessive_bools,
    reason = "independent switches of one control, as the CSS it draws"
)]
#[derive(IntoElement)]
pub struct Control {
    pub(crate) id: ElementId,
    pub(crate) width: Width,
    pub(crate) height: Option<Pixels>,
    pub(crate) min_height: Option<Pixels>,
    /// Left, top, right, bottom padding (the border width included).
    pub(crate) padding: [Pixels; 4],
    pub(crate) gap: Pixels,
    pub(crate) radius: Pixels,
    /// The inline start / end corners are square (the halves of a joined button group).
    pub(crate) square: [bool; 2],
    pub(crate) fill: Blend,
    pub(crate) fg: Blend,
    /// Border width and colours.
    pub(crate) border: Option<(Pixels, Blend)>,
    /// Shadows drawn with the surface at rest (and under the ring).
    pub(crate) shadows: Vec<BoxShadow>,
    pub(crate) ring: Ring,
    pub(crate) scale: bool,
    pub(crate) disabled: Disabled,
    pub(crate) disabled_look: DisabledLook,
    /// `cursor: not-allowed` while disabled (the opacity family defaults to `default`).
    pub(crate) not_allowed: bool,
    /// Whether Tab reaches the control (a roving group leaves one stop).
    pub(crate) tab_stop: bool,
    /// The focus handle, when the owner keeps it (a group that moves focus between its controls).
    pub(crate) focus: Option<gpui::FocusHandle>,
    pub(crate) text_size: Pixels,
    pub(crate) weight: f32,
    pub(crate) line_height: Option<Pixels>,
    pub(crate) underline: Underline,
    /// The surface reaches this far above and below the box (block bleed).
    pub(crate) bleed_y: Pixels,
    /// An atomic inline-level box (false: block-level, filling its container).
    pub(crate) inline: bool,
    pub(crate) justify_center: bool,
    pub(crate) on_click: Option<Handler>,
    pub(crate) children: Vec<AnyElement>,
    /// Extra paint on the surface layer (an inset ring, ...).
    pub(crate) overlay: Vec<AnyElement>,
    /// Applied to the outer element last (margins, translate, absolute position).
    pub(crate) outer: Option<Outer>,
    pub(crate) debug: Option<SharedString>,
}

impl Control {
    pub(crate) fn new(id: impl Into<ElementId>, ds: &Ds) -> Self {
        let none = gpui::transparent_black();
        Self {
            id: id.into(),
            width: Width::Auto,
            height: None,
            min_height: None,
            padding: [px(0.); 4],
            gap: px(0.),
            radius: px(0.),
            square: [false; 2],
            fill: Blend::flat(none),
            fg: Blend::flat(ds.color(Color::TextPrimary)),
            border: None,
            shadows: Vec::new(),
            ring: Ring::Spread,
            scale: true,
            disabled: Disabled::No,
            disabled_look: DisabledLook::Opacity(0.48),
            not_allowed: false,
            tab_stop: true,
            focus: None,
            text_size: ds.len(crate::tokens::Length::FontSize3),
            weight: ds.number(Number::FontWeightRegular),
            line_height: None,
            underline: Underline::Never,
            bleed_y: px(0.),
            inline: true,
            justify_center: true,
            on_click: None,
            children: Vec::new(),
            overlay: Vec::new(),
            outer: None,
            debug: None,
        }
    }

    pub(crate) fn on_click(&mut self, handler: Option<Handler>) {
        self.on_click = handler;
    }
}

impl RenderOnce for Control {
    fn render(mut self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let state = window.use_keyed_state((self.id.clone(), "state"), cx, |_, _| State::default());
        let handle = (self.disabled != Disabled::Native).then(|| {
            self.focus.take().unwrap_or_else(|| {
                window
                    .use_keyed_state((self.id.clone(), "focus"), cx, |_, cx| cx.focus_handle())
                    .read(cx)
                    .clone()
            })
        });
        let now = cx.background_executor().now();
        let (duration, ease) = {
            let ds = Ds::get(cx);
            (
                ds.duration(DsDuration::MotionFast),
                convert::easing(ds.tokens().ease(Easing::MotionEaseStandard)),
            )
        };
        let (instant, press_in) = {
            let ds = Ds::get(cx);
            (
                ds.duration(DsDuration::MotionInstant),
                1. - ds.number(Number::MotionScalePress),
            )
        };
        let (hover, moving, pressed, press) = state.update(cx, |s, _| {
            let (hover, moving) = s.sample(now, duration, &ease);
            let into = if s.pressed { instant } else { duration };
            let (press, pressing) = s.press.sample(now, into, &ease);
            (hover, moving || pressing, s.pressed, press)
        });
        if moving {
            window.request_animation_frame();
        }
        let shrink = super::strut::shrink_wrap(cx);
        if self.debug.is_none() {
            self.debug = Some(next_anchor(cx, handle.as_ref()));
        }
        let handed_off = focus::ring_handed_off(cx);
        let ds = Ds::get(cx);
        let live = !self.disabled.is_on();
        let (hover, pressed, press) = if live {
            (hover, pressed, press)
        } else {
            (0., false, 0.)
        };
        let focused = handle
            .as_ref()
            .is_some_and(|h| focus::visible(ds, h.is_focused(window), false));
        let publish = handle
            .as_ref()
            .filter(|h| focused && h.is_focused(window))
            .map(|h| (h.clone(), self.ring_reach(ds)));
        // A scroller that cannot show the ring whole draws it itself.
        let focused = focused && !handed_off;
        let mut el = self.frame(ds, hover, pressed, shrink);
        if self.scale && press > 0. {
            // DS: Button.module.css:47 `scale: var(--motion-scale-press)`.
            el = el.scale(1. - press_in * press);
        }
        if let Some(outer) = self.outer.take() {
            el = outer(el);
        }
        let el = self.interact(el, &state, handle.as_ref(), live);
        let el = self.finish(el, hover, pressed, focused, ds);
        let el = match publish {
            Some((handle, reach)) => el.child(focus::publish(handle, reach)),
            None => el,
        };
        el.children(self.children)
    }
}

impl Control {
    /// How far the ring paints past the box.
    fn ring_reach(&self, ds: &Ds) -> Pixels {
        let room = focus::room(ds);
        match self.ring {
            Ring::Spread => room,
            Ring::Outline(offset) => {
                room.max(px(offset) + ds.len(crate::tokens::Length::FocusRingWidth))
            }
        }
    }

    /// The outer box: size, padding, text style and the pointer cursor.
    fn frame(&self, ds: &Ds, hover: f32, pressed: bool, shrink: bool) -> gpui::Stateful<Div> {
        let mut el = div()
            .id(self.id.clone())
            .relative()
            .flex_none()
            .min_w_0()
            .pl(self.padding[0])
            .pt(self.padding[1])
            .pr(self.padding[2])
            .pb(self.padding[3])
            .gap(self.gap)
            .text_size(self.text_size)
            .font_family(ds.body_font().clone())
            .font_weight(gpui::FontWeight(self.weight))
            .text_color(self.fg_color(ds, hover, pressed));
        if let Some(line) = self.line_height {
            el = el.line_height(line);
        }
        el = if self.inline {
            el.inline_flex()
        } else {
            el.flex()
        }
        .items_center();
        if self.justify_center {
            el = el.justify_center();
        }
        el = match self.width {
            // `width: max-content` is not stretched by a column's `align-items: stretch`.
            Width::Auto if shrink => el.self_start(),
            Width::Auto | Width::Stretch => el,
            Width::Fixed(width) => el.w(px(width)),
            Width::Full => el.w_full(),
            Width::Grow => el.flex_1(),
        };
        if self.underline == Underline::Always
            || (self.underline == Underline::OnHover && hover > 0.5)
        {
            el = el.underline();
        }
        if let Some(height) = self.height {
            el = el.h(height);
        }
        if let Some(min) = self.min_height {
            el = el.min_h(min);
        }
        el
    }

    fn fg_color(&self, ds: &Ds, hover: f32, pressed: bool) -> Hsla {
        match (self.disabled.is_on(), self.disabled_look) {
            (true, DisabledLook::Text) => ds.color(Color::InteractiveDisabledFg),
            _ => self.fg.at(hover, pressed),
        }
    }

    /// Cursor, focus, hover and press tracking, and the click gate.
    fn interact(
        &self,
        el: gpui::Stateful<Div>,
        state: &gpui::Entity<State>,
        handle: Option<&gpui::FocusHandle>,
        live: bool,
    ) -> gpui::Stateful<Div> {
        let mut el = if live {
            el.cursor_pointer()
        } else if self.not_allowed || matches!(self.disabled_look, DisabledLook::Text) {
            el.cursor_not_allowed()
        } else {
            el.cursor_default()
        };
        if let Some(handle) = handle {
            el = el.track_focus(&focus::tab_stop(handle, self.tab_stop));
        }
        if live {
            let hover = state.clone();
            let press = state.clone();
            let release = state.clone();
            let release_out = state.clone();
            el = el
                .on_hover(move |on, _, cx| {
                    let now = cx.background_executor().now();
                    hover.update(cx, |s, cx| {
                        let at = s.mix;
                        s.retarget(*on, now, at);
                        if !*on {
                            s.set_pressed(false, now);
                        }
                        cx.notify();
                    });
                })
                .on_mouse_down(MouseButton::Left, move |_, _, cx| {
                    let now = cx.background_executor().now();
                    press.update(cx, |s, cx| {
                        s.set_pressed(true, now);
                        cx.notify();
                    });
                })
                .on_mouse_up(MouseButton::Left, move |_, _, cx| {
                    let now = cx.background_executor().now();
                    release.update(cx, |s, cx| {
                        s.set_pressed(false, now);
                        cx.notify();
                    });
                })
                .on_mouse_up_out(MouseButton::Left, move |_, _, cx| {
                    let now = cx.background_executor().now();
                    release_out.update(cx, |s, cx| {
                        s.set_pressed(false, now);
                        cx.notify();
                    });
                });
            if let Some(handler) = self.on_click.clone() {
                el = el.on_click(move |event, window, cx| handler(event, window, cx));
            }
        }
        el
    }

    /// The surface layer (fill, border, shadows, ring), then the opacity of disabled.
    fn finish(
        &mut self,
        el: gpui::Stateful<Div>,
        hover: f32,
        pressed: bool,
        focused: bool,
        ds: &Ds,
    ) -> gpui::Stateful<Div> {
        let mut surface = div().absolute();
        surface = if self.bleed_y > px(0.) {
            surface.top(-self.bleed_y).bottom(-self.bleed_y)
        } else {
            surface.top_0().bottom_0()
        };
        let mut surface = surface
            .left_0()
            .right_0()
            .rounded(self.radius)
            .bg(self.fill.at(hover, pressed));
        if self.square[0] {
            surface = surface.rounded_tl(px(0.)).rounded_bl(px(0.));
        }
        if self.square[1] {
            surface = surface.rounded_tr(px(0.)).rounded_br(px(0.));
        }
        if let Some((width, colors)) = self.border {
            surface = surface
                .border(width)
                .border_color(colors.at(hover, pressed));
        }
        let shadows = self.shadows.clone();
        if focused {
            match self.ring {
                Ring::Spread => {
                    // Outside the box only: a transparent surface must not fill with the ring.
                    surface = surface.child(ring_layer(focus::shadows(ds), self.radius));
                }
                Ring::Outline(offset) => {
                    surface = surface.child(outline(ds, self.radius, offset));
                }
            }
        }
        if !shadows.is_empty() {
            surface = surface.shadow(shadows);
        }
        let mut el = el.child(surface.children(std::mem::take(&mut self.overlay)));
        if let (true, DisabledLook::Opacity(opacity)) = (self.disabled.is_on(), self.disabled_look)
        {
            el = el.opacity(opacity);
        }
        if let Some(name) = self.debug.take() {
            el = el.debug_selector(move || name.to_string());
        }
        el
    }
}

/// The ring's spread shadows over the box, painted outside it.
pub(crate) fn ring_layer(ring: Vec<BoxShadow>, radius: Pixels) -> Div {
    div().absolute().top_0().left_0().size_full().child(
        gpui::canvas(
            |_, _, _| (),
            move |bounds, (), window, _| {
                let r = radius
                    .min(bounds.size.width / 2.)
                    .min(bounds.size.height / 2.);
                window.paint_drop_shadows_outside(bounds, gpui::Corners::all(r), 0., &ring);
            },
        )
        .absolute()
        .size_full(),
    )
}

/// `outline: 2px solid ring-colour` at `offset` from the box.
fn outline(ds: &Ds, radius: Pixels, offset: f32) -> Div {
    let width = f32::from(ds.len(crate::tokens::Length::FocusRingWidth));
    let grow = px(-(offset + width));
    div()
        .absolute()
        .top(grow)
        .bottom(grow)
        .left(grow)
        .right(grow)
        .rounded(radius + px(offset + width))
        .border(px(width))
        .border_color(ds.color(Color::ColorActionPrimary))
}
