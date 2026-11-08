//! DS Tooltip (shadcn/ui/tooltip.tsx): names a control. Opens after `TOOLTIP_DELAY_MS` of
//! hover or at once on keyboard focus, never within 800 ms of a window focus change, is placed
//! by [`place::place`] in the top layer, is hidden while its trigger is clipped out of sight,
//! and fades out keeping its last label and position.
pub mod place;

use std::cell::Cell;
use std::time::{Duration, Instant};

use gpui::{
    AnyElement, App, Bounds, Context, ElementId, Entity, FontWeight, InteractiveElement as _,
    IntoElement, ParentElement, Pixels, RenderOnce, SharedString, StatefulInteractiveElement as _,
    Styled as _, Subscription, Window, canvas, div, point, prelude::FluentBuilder as _, px,
};

pub use place::{Align, Side};

use super::context::Ds;
use super::layer::{Layer, Z, safe_top};
use super::liquid_glass;
use super::motion::{Timing, Tween};
use super::strut;
use super::tinted_glass::{GlassPadding, GlassRadius, TintedGlass};
use crate::tokens::{Color, Duration as DsDuration, Easing, Length, Number};

/// Hover delay before a tooltip opens (`TOOLTIP_DELAY_MS`).
const OPEN_DELAY: Duration = Duration::from_millis(650); // DS: tooltip.tsx:22
/// No focus-open for this long after the window gained or lost focus.
const WINDOW_FOCUS_SUPPRESSION: Duration = Duration::from_millis(800); // DS: tooltip.tsx:27
const OFFSET: f32 = 8.; // DS: tooltip.tsx:23
const FALLBACK_SIZE: (f32, f32) = (96., 32.); // DS: tooltip.tsx:24
const VIEWPORT_PADDING: f32 = 12.; // DS: tooltip.tsx:26
/// `padding: 6px 9px` of the tooltip surface.
const PADDING: (f32, f32) = (9., 6.); // DS: tooltip.module.css:16
/// `max-width: min(220px, 100vw - 24px)`.
const MAX_WIDTH: f32 = 220.; // DS: tooltip.module.css:14

/// The tooltips drawn this frame (a harness reads it; the page host resets it per frame).
#[derive(Default)]
struct ShownNow(std::cell::Cell<usize>);

impl gpui::Global for ShownNow {}

/// How many tooltips are open now.
pub fn shown_count(cx: &App) -> usize {
    cx.try_global::<ShownNow>().map_or(0, |shown| shown.0.get())
}

/// Restarts the count; the page host calls it once per frame.
pub fn reset_shown(cx: &mut App) {
    cx.default_global::<ShownNow>().0.set(0);
}

#[derive(Clone)]
struct Shown {
    label: SharedString,
    side: Side,
    left: f32,
    top: f32,
    wrap: bool,
    clipped: bool,
}

/// Per-tooltip runtime state.
#[expect(
    clippy::struct_excessive_bools,
    reason = "independent flags of one tooltip"
)]
struct State {
    hovered: bool,
    /// The trigger had visible focus on the last render.
    focus_open: bool,
    open: bool,
    /// Bumped by every hover change, so a stale delay timer does nothing.
    generation: usize,
    trigger: Option<Bounds<Pixels>>,
    clipped: bool,
    size: Option<(f32, f32)>,
    suppress_until: Option<Instant>,
    last: Option<Shown>,
    /// When the current open or close began (the key of the enter and exit animations).
    changed: usize,
    closed_at: Option<Instant>,
    _activation: Option<Subscription>,
}

impl State {
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let subscription = cx.observe_window_activation(window, |this, _, cx| {
            this.suppress_until = Some(cx.background_executor().now() + WINDOW_FOCUS_SUPPRESSION);
            this.hide(cx);
        });
        Self {
            hovered: false,
            focus_open: false,
            open: false,
            generation: 0,
            trigger: None,
            clipped: false,
            size: None,
            suppress_until: None,
            last: None,
            changed: 0,
            closed_at: None,
            _activation: Some(subscription),
        }
    }

    fn show(&mut self, cx: &mut Context<Self>) {
        if !self.open {
            self.open = true;
            self.changed += 1;
            self.closed_at = None;
            cx.notify();
        }
    }

    fn hide(&mut self, cx: &mut Context<Self>) {
        self.generation += 1;
        self.hovered = false;
        if self.open {
            self.open = false;
            self.closed_at = Some(cx.background_executor().now());
            cx.notify();
        }
    }
}

#[derive(IntoElement)]
pub struct Tooltip {
    id: ElementId,
    label: Option<SharedString>,
    wrap: bool,
    side: Side,
    align: Align,
    open: Option<bool>,
    fill: bool,
    child: Option<AnyElement>,
}

impl Tooltip {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            label: None,
            wrap: false,
            side: Side::Top,
            align: Align::Center,
            open: None,
            fill: false,
            child: None,
        }
    }

    /// The trigger takes the room its parent gives it (a truncating label) instead of its
    /// content's size.
    pub fn fill(mut self) -> Self {
        self.fill = true;
        self
    }

    /// Without a label the tooltip never opens.
    pub fn label(mut self, label: impl Into<SharedString>) -> Self {
        self.label = Some(label.into());
        self
    }

    /// A long label wraps within the tooltip's width instead of one line.
    pub fn wrap(mut self) -> Self {
        self.wrap = true;
        self
    }

    pub fn side(mut self, side: Side) -> Self {
        self.side = side;
        self
    }

    pub fn align(mut self, align: Align) -> Self {
        self.align = align;
        self
    }

    /// Controlled visibility, shown regardless of hover and focus (documentation).
    pub fn open(mut self, open: bool) -> Self {
        self.open = Some(open);
        self
    }
}

impl ParentElement for Tooltip {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.child = elements.into_iter().last().or(self.child.take());
    }
}

impl RenderOnce for Tooltip {
    fn render(mut self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let state = window.use_keyed_state((self.id.clone(), "tip"), cx, State::new);
        let handle = window
            .use_keyed_state((self.id.clone(), "focus"), cx, |_, cx| cx.focus_handle())
            .read(cx)
            .clone();
        let keyboard = Ds::get(cx).modality() == super::context::Modality::Keyboard;
        let focused = handle.contains_focused(window, cx) && keyboard;
        let has_label = self.label.is_some();
        let now = cx.background_executor().now();
        state.update(cx, |s, cx| {
            if focused && !s.focus_open && has_label {
                let allowed = s.suppress_until.is_none_or(|until| now >= until);
                if allowed {
                    s.show(cx);
                }
            } else if !focused && s.focus_open {
                s.hide(cx);
            }
            s.focus_open = focused;
        });
        let shrink = strut::shrink_wrap(cx);
        let layer = self.layer(&state, window, cx);
        let child = self.child.take();
        let hover_state = state.clone();
        let press_state = state.clone();
        let label = self.label.is_some();
        let mut wrapper = div()
            .id(self.id.clone())
            .relative()
            .inline_flex()
            .flex_none()
            .track_focus(&handle)
            .tab_stop(false)
            .on_hover(move |on, window, cx| {
                on_hover(&hover_state, *on, label, window, cx);
            })
            // Radix closes on pointer down and stays closed until the pointer leaves and returns.
            .capture_any_mouse_down(move |_, _, cx| press_state.update(cx, State::hide));
        if self.fill {
            wrapper = wrapper.flex_1().min_w_0();
        }
        if shrink {
            wrapper = wrapper.self_start();
        }
        wrapper
            .children(child)
            .child(bounds_probe(&state))
            .children(layer)
    }
}

/// Starts or cancels the hover timer.
fn on_hover(state: &Entity<State>, on: bool, label: bool, window: &mut Window, cx: &mut App) {
    if !on || !label {
        state.update(cx, State::hide);
        return;
    }
    let generation = state.update(cx, |s, _| {
        s.hovered = true;
        s.generation += 1;
        s.generation
    });
    let entity = state.clone();
    window
        .spawn(cx, async move |cx| {
            cx.background_executor().timer(OPEN_DELAY).await;
            cx.update(|_, cx| {
                entity.update(cx, |s, cx| {
                    if s.hovered && s.generation == generation {
                        s.show(cx);
                    }
                });
            })
            .ok();
        })
        .detach();
}

/// Records the trigger's window bounds and whether its ancestors clip it out of sight entirely.
fn bounds_probe(state: &Entity<State>) -> gpui::Div {
    let state = state.clone();
    div().absolute().top_0().left_0().size_full().child(
        canvas(
            move |bounds, window, cx| {
                let visible = bounds.intersect(&window.content_mask().bounds);
                let clipped = visible.size.width <= px(0.) || visible.size.height <= px(0.);
                state.update(cx, |s, cx| {
                    if s.trigger != Some(bounds) || s.clipped != clipped {
                        s.trigger = Some(bounds);
                        s.clipped = clipped;
                        cx.notify();
                    }
                });
            },
            |_, (), _, _| {},
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full(),
    )
}

impl Tooltip {
    /// The placement of the label now, from the trigger's last bounds and the tooltip's last size.
    fn placed(&self, state: &Entity<State>, window: &Window, cx: &App) -> Option<Shown> {
        let label = self.label.clone()?;
        let s = state.read(cx);
        let trigger = s.trigger?;
        let viewport = window.viewport_size();
        let rect = place::Rect {
            left: f32::from(trigger.origin.x),
            top: f32::from(trigger.origin.y),
            width: f32::from(trigger.size.width),
            height: f32::from(trigger.size.height),
        };
        let bounds = place::Bounds {
            width: f32::from(viewport.width),
            height: f32::from(viewport.height),
            padding: VIEWPORT_PADDING,
            safe_top: safe_top(Ds::get(cx)),
            offset: OFFSET,
        };
        let size = s.size.unwrap_or(FALLBACK_SIZE);
        let placed = place::place(rect, size, self.side, self.align, bounds);
        Some(Shown {
            label,
            side: placed.side,
            left: placed.left,
            top: placed.top,
            wrap: self.wrap,
            clipped: s.clipped,
        })
    }

    /// The tooltip surface in the top layer: shown, fading out, or nothing.
    fn layer(&self, state: &Entity<State>, window: &mut Window, cx: &mut App) -> Option<Layer> {
        let now = cx.background_executor().now();
        let exit = Ds::get(cx).duration(DsDuration::MotionExitFast);
        let open = self.open.unwrap_or_else(|| state.read(cx).open);
        let placement = self.placed(state, window, cx);
        let (shown, key) = state.update(cx, |s, _| {
            if let (true, Some(shown)) = (open, placement) {
                s.last = Some(shown);
            }
            let exiting = !open
                && s.closed_at
                    .is_some_and(|at| now.saturating_duration_since(at) < exit);
            (s.last.clone().filter(|_| open || exiting), s.changed)
        });
        let shown = shown?;
        if open {
            let count = cx.default_global::<ShownNow>();
            count.0.set(count.0.get() + 1);
        }
        let cap = (f32::from(window.viewport_size().width) - 2. * VIEWPORT_PADDING).min(MAX_WIDTH);
        let ds = Ds::get(cx);
        let content = Self::surface(&shown, cap, state, ds);
        let origin = point(px(shown.left), px(shown.top));
        let id = ElementId::from(SharedString::from(format!("{}-{key}-{open}", self.id)));
        let animated = if open {
            let timing = Timing::token(ds, DsDuration::MotionEnterMenu, Easing::MotionEaseEnter);
            let travel = f32::from(ds.len(Length::MotionDistanceSm));
            let (dx, dy) = match shown.side {
                Side::Top => (0., travel),
                Side::Bottom => (0., -travel),
                Side::Left => (travel, 0.),
                Side::Right => (-travel, 0.),
            };
            // The glass takes the progress as its presence, not as an opacity.
            let content = Cell::new(Some(content));
            Tween::new(id, div().relative(), timing, move |el, t| {
                el.left(px(dx * (1. - t)))
                    .top(px(dy * (1. - t)))
                    .child(liquid_glass::with_presence(t, shown_content(&content)))
            })
            .into_any_element()
        } else {
            let timing =
                Timing::token(ds, DsDuration::MotionExitFast, Easing::MotionEaseAccelerate);
            let content = Cell::new(Some(content));
            Tween::new(id, div(), timing, move |el, t| {
                el.child(liquid_glass::with_presence(1. - t, shown_content(&content)))
            })
            .into_any_element()
        };
        let hidden = shown.clipped;
        Some(Layer::new(
            Z::Tooltip,
            origin,
            div().when(hidden, gpui::Styled::invisible).child(animated),
        ))
    }

    /// The glass surface with the label, measured for the next placement.
    fn surface(shown: &Shown, cap: f32, state: &Entity<State>, ds: &Ds) -> AnyElement {
        let text = div()
            .px(px(PADDING.0))
            .py(px(PADDING.1))
            .max_w(px(cap))
            .text_color(ds.color(Color::TextPrimary))
            .text_size(ds.len(Length::FontSize2))
            .font_family(ds.body_font().clone())
            .font_weight(FontWeight(ds.number(Number::FontWeightMedium)))
            .line_height(ds.len(Length::TypoLabelLineHeight));
        let text = if shown.wrap {
            text.child(shown.label.clone())
        } else {
            text.text_center()
                .whitespace_nowrap()
                .child(shown.label.clone())
        };
        let state = state.clone();
        let probe = canvas(
            move |bounds, _, cx| {
                let size = (f32::from(bounds.size.width), f32::from(bounds.size.height));
                state.update(cx, |s, cx| {
                    if s.size != Some(size) {
                        s.size = Some(size);
                        cx.notify();
                    }
                });
            },
            |_, (), _, _| {},
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full();
        div()
            .relative()
            .child(
                TintedGlass::new()
                    .radius(GlassRadius::Control)
                    .padding(GlassPadding::None)
                    .child(text),
            )
            .child(probe)
            .into_any_element()
    }
}

/// The surface held for the animation's one build, taken out when the Tween applies it.
fn shown_content(content: &Cell<Option<AnyElement>>) -> AnyElement {
    content
        .take()
        .unwrap_or_else(|| gpui::Empty.into_any_element())
}
