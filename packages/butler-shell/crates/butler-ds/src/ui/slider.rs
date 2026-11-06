//! DS Slider (Slider.tsx / Slider.module.css): a native-range look. An 18px-tall hit box with a
//! 5px pill track filled with `--accent` up to the value over `--context-track-bg`, and a 16px
//! thumb that carries the focus ring (`--focus-ring, --shadow-control`). A press jumps the thumb
//! to the pointer and a drag follows it; the arrows step by `step`, Home and End go to the ends
//! and PageUp and PageDown take a tenth of the range (the browser's larger step). No hover state
//! and no motion. Disabled fades to 0.48 and takes no input.
use std::rc::Rc;

use gpui::{
    App, Bounds, DispatchPhase, ElementId, Entity, InteractiveElement as _, IntoElement,
    MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, ParentElement as _, Pixels,
    RenderOnce, Styled as _, Window, canvas, div, px, relative,
};

use super::context::Ds;
use super::control::next_anchor;
use super::convert;
use super::focus;
use crate::tokens::{Color, Length, Shadow};

type Handler = Rc<dyn Fn(f64, &mut Window, &mut App)>;

/// The hit box height, thumb diameter and track thickness.
const HEIGHT: f32 = 18.; // DS: Slider.module.css:4
const THUMB: f32 = 16.; // DS: Slider.module.css:29
const TRACK: f32 = 5.; // DS: Slider.module.css:15

#[derive(IntoElement)]
pub struct Slider {
    id: ElementId,
    value: f64,
    min: f64,
    max: f64,
    step: f64,
    disabled: bool,
    on_change: Option<Handler>,
}

impl Slider {
    pub fn new(id: impl Into<ElementId>, value: f64, min: f64, max: f64) -> Self {
        Self {
            id: id.into(),
            value,
            min,
            max,
            step: 1.,
            disabled: false,
            on_change: None,
        }
    }

    pub fn step(mut self, step: f64) -> Self {
        self.step = step;
        self
    }

    pub fn disabled(mut self) -> Self {
        self.disabled = true;
        self
    }

    pub fn on_value_change(
        mut self,
        handler: impl Fn(f64, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_change = Some(Rc::new(handler));
        self
    }

    /// The fraction of the range the value is at, 0 to 1.
    fn fraction(&self) -> f32 {
        if self.max > self.min {
            #[expect(clippy::cast_possible_truncation, reason = "a fraction of a slider")]
            let fraction = ((self.value - self.min) / (self.max - self.min)).clamp(0., 1.) as f32;
            fraction
        } else {
            0.
        }
    }
}

/// What the keyboard and pointer need to compute a new value.
#[derive(Clone, Copy)]
struct Range {
    min: f64,
    max: f64,
    step: f64,
}

impl Range {
    /// `value` snapped to the step grid from `min` and kept inside the range.
    fn snap(self, value: f64) -> f64 {
        let step = if self.step > 0. { self.step } else { 1. };
        let snapped = self.min + ((value - self.min) / step).round() * step;
        snapped.clamp(self.min, self.max.max(self.min))
    }

    /// The value under pointer fraction `f` of the thumb's travel.
    fn at(self, f: f32) -> f64 {
        self.snap(self.min + (self.max - self.min) * f64::from(f.clamp(0., 1.)))
    }

    /// The value a key moves to, from `value`.
    fn key(self, key: &str, value: f64) -> Option<f64> {
        let page = ((self.max - self.min) / 10.).max(self.step);
        Some(self.snap(match key {
            "right" | "up" => value + self.step,
            "left" | "down" => value - self.step,
            "pageup" => value + page,
            "pagedown" => value - page,
            "home" => self.min,
            "end" => self.max,
            _ => return None,
        }))
    }
}

impl RenderOnce for Slider {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let live = !self.disabled;
        let handle = live.then(|| {
            window
                .use_keyed_state((self.id.clone(), "focus"), cx, |_, cx| cx.focus_handle())
                .read(cx)
                .clone()
        });
        let anchor = next_anchor(cx, handle.as_ref());
        let dragging = window.use_keyed_state((self.id.clone(), "drag"), cx, |_, _| false);
        let focused = handle
            .as_ref()
            .is_some_and(|h| focus::visible(Ds::get(cx), h.is_focused(window), false));
        let fraction = self.fraction();
        let range = Range {
            min: self.min,
            max: self.max,
            step: self.step,
        };
        let ds = Ds::get(cx);
        let mut root = div()
            .id(self.id.clone())
            .relative()
            .w_full()
            .h(px(HEIGHT))
            .my(px(2.)) // the UA's `margin: 2px` of a range input; only the inline margin is reset
            .flex_none()
            .child(track(ds, fraction))
            .child(thumb(ds, fraction, focused))
            .debug_selector(move || anchor.to_string());
        if let (Some(handle), Some(on_change)) = (handle.clone(), self.on_change.clone()) {
            let (value, keys) = (self.value, on_change.clone());
            root = root
                .track_focus(&handle)
                .tab_stop(true)
                .cursor_pointer()
                .on_key_down(move |event, window, cx| {
                    if let Some(next) = range.key(&event.keystroke.key, value) {
                        cx.stop_propagation();
                        keys(next, window, cx);
                    }
                })
                .child(pointer_layer(range, handle, dragging, on_change));
        } else {
            root = root.cursor_default().opacity(0.48); // DS: Slider.module.css:63
        }
        root
    }
}

fn track(ds: &Ds, fraction: f32) -> gpui::Div {
    let top = px((HEIGHT - TRACK) / 2.);
    let pill = ds.len(Length::RadiusPill);
    let fill = div()
        .absolute()
        .top_0()
        .left_0()
        .h_full()
        .w(relative(fraction))
        .rounded_l(pill)
        .bg(ds.color(Color::Accent));
    div()
        .absolute()
        .top(top)
        .left_0()
        .right_0()
        .h(px(TRACK))
        .rounded(pill)
        .bg(ds.color(Color::ContextTrackBg))
        .child(if fraction >= 1. {
            fill.rounded_r(pill)
        } else {
            fill
        })
}

/// The thumb: it travels `width - 16` while the value goes from min to max.
fn thumb(ds: &Ds, fraction: f32, focused: bool) -> gpui::Div {
    let mut shadows = if focused {
        focus::shadows(ds)
    } else {
        Vec::new()
    };
    shadows.extend(convert::box_shadows(
        ds.tokens().shadow(Shadow::ShadowControl),
        ds.tokens(),
    ));
    let border = convert::with_alpha(ds.color(Color::LineStrong), 0.6); // DS: Slider.module.css:32
    div()
        .absolute()
        .top(px((HEIGHT - THUMB) / 2.))
        .left(relative(fraction))
        .ml(px(-THUMB * fraction))
        .size(px(THUMB))
        .rounded(ds.len(Length::RadiusPill))
        .border(px(1.)) // DS: Slider.module.css:31
        .border_color(border)
        .bg(ds.color(Color::SurfaceRaised))
        .shadow(shadows)
}

/// Covers the hit box: a press jumps to the pointer and focuses, and the drag follows it until
/// the button is released, wherever the pointer goes.
fn pointer_layer(
    range: Range,
    handle: gpui::FocusHandle,
    dragging: Entity<bool>,
    on_change: Handler,
) -> impl IntoElement {
    canvas(
        |_, _, _| (),
        move |bounds, (), window, _| {
            let (down, drag, up) = (dragging.clone(), dragging.clone(), dragging.clone());
            let (focus, press, mv) = (handle.clone(), on_change.clone(), on_change.clone());
            window.on_mouse_event(move |event: &MouseDownEvent, phase, window, cx| {
                if phase == DispatchPhase::Bubble
                    && event.button == MouseButton::Left
                    && bounds.contains(&event.position)
                {
                    down.update(cx, |d, _| *d = true);
                    window.focus(&focus, cx);
                    press(range.at(travel(bounds, event.position.x)), window, cx);
                }
            });
            window.on_mouse_event(move |event: &MouseMoveEvent, phase, window, cx| {
                if phase == DispatchPhase::Bubble && *drag.read(cx) {
                    mv(range.at(travel(bounds, event.position.x)), window, cx);
                }
            });
            window.on_mouse_event(move |_: &MouseUpEvent, _, _, cx| {
                up.update(cx, |d, _| *d = false);
            });
        },
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full()
}

/// The fraction of the thumb's travel (centre to centre) at pointer `x`.
fn travel(bounds: Bounds<Pixels>, x: Pixels) -> f32 {
    let room = f32::from(bounds.size.width) - THUMB;
    if room <= 0. {
        return 0.;
    }
    (f32::from(x - bounds.origin.x) - THUMB / 2.) / room
}
