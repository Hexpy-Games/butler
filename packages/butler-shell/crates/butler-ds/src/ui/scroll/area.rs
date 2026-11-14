//! DS ScrollArea (ScrollArea.tsx / ScrollArea.module.css): a frame that clips, a scroller with
//! the edge fades, and a content column. The frame is `--focus-ring-room` wider at the inline
//! start and the content pads it back, so a ring at the column edge paints inside the clip. A
//! scrollbar lane past the column is reserved whether or not the content overflows, so the content
//! ends on the same edge either way; gpui draws an overlay scrollbar, which takes no layout width.
use gpui::{
    AnyElement, App, ElementId, Entity, InteractiveElement as _, IntoElement, ParentElement,
    Pixels, RenderOnce, ScrollHandle, SharedString, StatefulInteractiveElement as _, Styled as _,
    Window, div, px, relative,
};

use super::bar;
use super::engine::{self, Axis, Config};
use crate::tokens::{Color, Length};
use crate::ui::context::Ds;
use crate::ui::{convert, strut};

/// Cap the height; the area scrolls beyond it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MaxHeight {
    /// `--scroll-area-max-height-xs` (180px).
    Xs,
    /// `--scroll-area-max-height-sm` (320px).
    Sm,
}

/// Keep at least this height (`--scroll-area-min-height-xs`, 96px).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MinHeight {
    Xs,
}

/// Extend into the container's inline-end padding (the inspector gutter).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Bleed {
    InlineEnd,
}

/// The lane is never narrower than this (DS: ScrollArea.module.css:15).
const LANE_MIN: f32 = 10.;
/// The inspector gutter the bleed reaches into: `--inspector-inline-padding`, 18px fallback
/// (DS: ScrollArea.module.css:53).
const BLEED: f32 = 18.;
/// The fade a bleeding area uses (DS: ScrollArea.module.css:57).
const BLEED_FADE: f32 = 10.;

#[derive(IntoElement)]
pub struct ScrollArea {
    id: ElementId,
    orientation: Axis,
    handle: Option<ScrollHandle>,
    max_height: Option<MaxHeight>,
    min_height: Option<MinHeight>,
    fill: bool,
    bleed: Option<Bleed>,
    probe: Option<SharedString>,
    /// `contentClassName` padding: (top, bottom, inline start), replacing the column's own.
    padding: Option<(Pixels, Pixels, Pixels)>,
    children: Vec<AnyElement>,
}

impl ScrollArea {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            orientation: Axis::Y,
            handle: None,
            max_height: None,
            min_height: None,
            fill: false,
            bleed: None,
            probe: None,
            padding: None,
            children: Vec::new(),
        }
    }

    /// The scrolling axis; the edge fade follows it.
    pub fn orientation(mut self, orientation: Axis) -> Self {
        self.orientation = orientation;
        self
    }

    /// Electron `ScrollArea.tsx`: share the actual viewport handle with its owner.
    pub fn handle(mut self, handle: ScrollHandle) -> Self {
        self.handle = Some(handle);
        self
    }

    pub fn max_height(mut self, max_height: MaxHeight) -> Self {
        self.max_height = Some(max_height);
        self
    }

    pub fn min_height(mut self, min_height: MinHeight) -> Self {
        self.min_height = Some(min_height);
        self
    }

    /// Take the remaining space of a flex column (`flex: 1; min-height: 0`).
    pub fn fill(mut self) -> Self {
        self.fill = true;
        self
    }

    /// Replaces the vertical column's block padding (the fade) and its inline-start ring room, as
    /// a `contentClassName` that sets `padding-block` and `padding-inline` does. The scrollbar
    /// lane at the end stays: it is the viewport's gutter, not the content's padding.
    pub fn content_padding(mut self, top: Pixels, bottom: Pixels, start: Pixels) -> Self {
        self.padding = Some((top, bottom, start));
        self
    }

    pub fn bleed(mut self, bleed: Bleed) -> Self {
        self.bleed = Some(bleed);
        self
    }

    /// Names a zero-size marker that reports the scroll edges (`<name>:start|middle|end|fits`),
    /// for a harness expectation. Only the test build draws it.
    pub fn probe(mut self, name: impl Into<SharedString>) -> Self {
        self.probe = Some(name.into());
        self
    }
}

impl ParentElement for ScrollArea {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

/// The lengths one area is laid out with.
struct Metrics {
    room: Pixels,
    lane: Pixels,
    fade: Pixels,
    guard: Pixels,
    edge: Pixels,
}

impl Metrics {
    fn of(area: &ScrollArea, ds: &Ds) -> Self {
        let room = ds.len(Length::FocusRingRoom);
        let guard = ds.len(Length::SpaceXs);
        let (lane, fade, edge) = match (area.orientation, area.bleed) {
            (Axis::Y, Some(Bleed::InlineEnd)) => (px(BLEED), px(BLEED_FADE), guard),
            _ => {
                let fade = ds.len(Length::ScrollFadeSize);
                (px(LANE_MIN).max(room), fade, fade)
            }
        };
        Self {
            room,
            lane,
            fade,
            guard,
            edge,
        }
    }
}

impl RenderOnce for ScrollArea {
    fn render(mut self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let metrics = Metrics::of(&self, Ds::get(cx));
        let ds = Ds::get(cx);
        let x = self.orientation == Axis::X;
        let height = |max: MaxHeight| match max {
            MaxHeight::Xs => ds.len(Length::ScrollAreaMaxHeightXs),
            MaxHeight::Sm => ds.len(Length::ScrollAreaMaxHeightSm),
        };
        let max = self.max_height.map(height);
        let min = self
            .min_height
            .map(|_| ds.len(Length::ScrollAreaMinHeightXs));
        let content = self.content(&metrics);
        let mut scroller = div()
            .flex()
            .flex_col()
            .w_full()
            .min_w_0()
            .min_h_0()
            .child(content);
        if let Some(max) = max {
            scroller = scroller.max_h(max);
        }
        if self.fill || min.is_some() {
            scroller = scroller.h_full();
        }
        let config = Config {
            id: self.id.clone(),
            axis: self.orientation,
            size: metrics.fade,
            guard: metrics.guard,
        };
        if let Some(handle) = self.handle.clone() {
            engine::state(&config, window, cx).update(cx, |state, _| state.handle = handle);
        }
        let built = engine::scroller(&config, scroller, window, cx);
        let mut frame = div()
            .id(self.id.clone())
            .relative()
            .min_w_0()
            .min_h_0()
            .overflow_hidden();
        frame = if x {
            frame.max_w_full().my(-metrics.room)
        } else {
            frame.ml(-metrics.room).mr(-metrics.lane)
        };
        if let Some(max) = max {
            frame = frame.max_h(max);
        }
        if let Some(min) = min {
            frame = frame.min_h(min);
        }
        if self.fill {
            // `flex: 1 1 auto`: the content's own height up to what the column leaves. A scroll
            // container contributes no height of its own to its parent's size, so the basis is
            // the content height the scroller reported on the last frame.
            frame = frame.flex_auto();
            if let Some(basis) = content_basis(&self.id, &built.handle, window, cx) {
                frame = frame.flex_basis(basis);
            }
        }
        let thumb = convert::with_alpha(Ds::get(cx).color(Color::LineStrong), 0.7);
        let overlay = self.overlay(&built, &metrics, thumb, window, cx);
        let ring = built.host.then(|| host_ring(Ds::get(cx)));
        let probe = self
            .probe
            .take()
            .map(|name| edge_probe(&built, self.orientation, name));
        frame
            .child(built.element)
            .child(overlay)
            .children(ring)
            .children(probe)
    }
}

/// The scrolled content's height (the viewport plus what scrolls), once the scroller has laid out;
/// asks for another frame when it changes, so the next one uses it.
fn content_basis(
    id: &ElementId,
    handle: &gpui::ScrollHandle,
    window: &mut Window,
    cx: &mut App,
) -> Option<gpui::Length> {
    let seen = window.use_keyed_state((id.clone(), "basis"), cx, |_, _| 0_f32);
    let height = f32::from(handle.bounds().size.height + handle.max_offset().y);
    if (height - *seen.read(cx)).abs() > 0.5 {
        seen.update(cx, |seen, _| *seen = height);
        crate::ui::motion::remeasure(window);
    }
    (height > 0.).then(|| px(height).into())
}

impl ScrollArea {
    /// The column the children flow in, padded for the ring room, the fade and the lane.
    fn content(&mut self, metrics: &Metrics) -> gpui::Div {
        let column = if self.orientation == Axis::X {
            div()
                .flex()
                .flex_row()
                .flex_none()
                .min_w(relative(1.))
                .py(metrics.room)
                .px(metrics.edge)
        } else {
            let end = if self.bleed.is_some() {
                px(BLEED)
            } else {
                metrics.lane
            };
            let column = div().flex().flex_col().flex_none().w_full();
            match self.padding {
                Some((top, bottom, start)) => column.pt(top).pb(bottom).pl(start).pr(end),
                None => column.py(metrics.edge).pl(metrics.room).pr(end),
            }
        };
        let stretch = self.orientation == Axis::Y;
        column.children(
            std::mem::take(&mut self.children)
                .into_iter()
                .map(|child| strut::flex_scope(stretch, child)),
        )
    }

    /// The thumb and its drag layer, over the lane.
    fn overlay(
        &self,
        built: &engine::Scroller,
        metrics: &Metrics,
        color: gpui::Hsla,
        window: &mut Window,
        cx: &mut App,
    ) -> gpui::Div {
        overlay(
            &self.id,
            built,
            (self.orientation, metrics.lane),
            color,
            window,
            cx,
        )
    }
}

/// The thumb and its drag layer of the scroller `id`, over a lane of `lane` px past the column.
pub(crate) fn overlay(
    id: &ElementId,
    built: &engine::Scroller,
    (axis, lane): (Axis, Pixels),
    color: gpui::Hsla,
    window: &mut Window,
    cx: &mut App,
) -> gpui::Div {
    let grab: Entity<Option<f32>> = window.use_keyed_state((id.clone(), "grab"), cx, |_, _| None);
    let near = window.use_keyed_state((id.clone(), "near"), cx, |_, _| false);
    let shown = built.lingering || *near.read(cx) || grab.read(cx).is_some();
    let strip = match axis {
        Axis::Y => div().absolute().top_0().bottom_0().right_0().w(lane),
        Axis::X => div().absolute().left_0().right_0().bottom_0().h(lane),
    };
    let hover = near.clone();
    let strip = strip
        .id((id.clone(), "lane"))
        .on_hover(move |on, _, cx| {
            hover.update(cx, |near, cx| {
                *near = *on;
                cx.notify();
            });
        })
        .child(bar::drag_layer(built.handle.clone(), axis, grab));
    let thumb = shown
        .then(|| bar::thumb(&built.handle, axis, color))
        .flatten();
    div()
        .absolute()
        .size_full()
        .top_0()
        .left_0()
        .children(thumb)
        .child(strip)
}

/// The scroller draws the ring of a control too large to show whole: `outline: 2px solid` at
/// offset -2px, inset on its own box (scroll-fade.css `[data-focus-ring-host]`).
fn host_ring(ds: &Ds) -> gpui::Div {
    div()
        .absolute()
        .size_full()
        .top_0()
        .left_0()
        .border(ds.len(Length::FocusRingWidth))
        .border_color(ds.color(Color::ColorActionPrimary))
}

/// `name:state`, a zero-size marker for the harness.
fn edge_probe(built: &engine::Scroller, axis: Axis, name: SharedString) -> gpui::Div {
    let flags = engine::read(&built.handle, axis);
    let state = match (flags.overflowing, flags.at_start, flags.at_end) {
        (false, ..) => "fits",
        (true, true, _) => "start",
        (true, _, true) => "end",
        _ => "middle",
    };
    div()
        .absolute()
        .size_0()
        .debug_selector(move || format!("{name}:{state}"))
}
