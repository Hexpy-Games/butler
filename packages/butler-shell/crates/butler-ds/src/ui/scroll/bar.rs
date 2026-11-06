//! The scrollbar ScrollArea draws (gpui paints none): a thin pill thumb in the lane past the
//! column, shown while the pointer is in the lane, while it drags and for a moment after the
//! content scrolls, like an overlay scrollbar. The track is 8px with a 2px transparent border
//! (ScrollArea.module.css `::-webkit-scrollbar`), so the thumb is 4px across.
use gpui::{
    Bounds, DispatchPhase, Hsla, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, Pixels,
    Point, ScrollHandle, Window, canvas, div, point, px,
};
use gpui::{ParentElement as _, Styled as _};

use super::engine::Axis;

/// The track's width and the border that insets the thumb (DS: ScrollArea.module.css:136-151).
const TRACK: f32 = 8.;
const BORDER: f32 = 2.;
/// A thumb never shrinks below this length.
const MIN_THUMB: f32 = 18.;

/// Where the thumb sits along the axis, from the scroller's box and offsets.
#[derive(Clone, Copy)]
struct Metrics {
    /// Scroll position, the farthest it goes, and the viewport length (all along the axis).
    position: f32,
    max: f32,
    view: f32,
}

impl Metrics {
    fn read(handle: &ScrollHandle, axis: Axis) -> Option<Self> {
        let (offset, max, view) = match axis {
            Axis::X => (
                handle.offset().x,
                handle.max_offset().x,
                handle.bounds().size.width,
            ),
            Axis::Y => (
                handle.offset().y,
                handle.max_offset().y,
                handle.bounds().size.height,
            ),
        };
        let (max, view) = (f32::from(max), f32::from(view));
        (max > 0. && view > 0.).then_some(Self {
            position: (-f32::from(offset)).clamp(0., max),
            max,
            view,
        })
    }

    fn length(self) -> f32 {
        (self.view * self.view / (self.view + self.max))
            .max(MIN_THUMB)
            .min(self.view)
    }

    fn travel(self) -> f32 {
        (self.view - self.length()).max(0.)
    }

    fn start(self) -> f32 {
        self.position / self.max * self.travel()
    }
}

/// The thumb as an absolute box in the frame, `lane` px of room past the column.
pub(super) fn thumb(handle: &ScrollHandle, axis: Axis, color: Hsla) -> Option<gpui::Div> {
    let metrics = Metrics::read(handle, axis)?;
    let across = px(BORDER);
    let (start, length) = (px(metrics.start()), px(metrics.length()));
    let thin = px(TRACK - 2. * BORDER);
    Some(
        match axis {
            Axis::Y => div().top(start).h(length).right(across).w(thin),
            Axis::X => div().left(start).w(length).bottom(across).h(thin),
        }
        .absolute()
        .rounded(px(999.))
        .bg(color),
    )
}

/// Press and drag over the lane (`lane`: its box in the window): a press on the thumb grabs it,
/// a press elsewhere in the lane centres the thumb on the pointer, and the drag follows until the
/// button is released, wherever the pointer goes.
pub(super) fn drag_layer(
    handle: ScrollHandle,
    axis: Axis,
    grab: gpui::Entity<Option<f32>>,
) -> gpui::Div {
    div().absolute().size_full().top_0().left_0().child(
        canvas(
            |_, _, _| (),
            move |bounds, (), window, _| install(bounds, &handle, axis, &grab, window),
        )
        .absolute()
        .size_full(),
    )
}

fn along(p: Point<Pixels>, axis: Axis) -> f32 {
    f32::from(match axis {
        Axis::X => p.x,
        Axis::Y => p.y,
    })
}

fn install(
    lane: Bounds<Pixels>,
    handle: &ScrollHandle,
    axis: Axis,
    grab: &gpui::Entity<Option<f32>>,
    window: &mut Window,
) {
    let origin = along(lane.origin, axis);
    let (down, drag, up) = (grab.clone(), grab.clone(), grab.clone());
    let (mover, presser) = (handle.clone(), handle.clone());
    window.on_mouse_event(move |event: &MouseDownEvent, phase, _, cx| {
        let Some(metrics) = Metrics::read(&presser, axis) else {
            return;
        };
        if phase != DispatchPhase::Bubble
            || event.button != MouseButton::Left
            || !lane.contains(&event.position)
        {
            return;
        }
        let pointer = along(event.position, axis) - origin;
        let start = metrics.start();
        let grabbed = if (start..=start + metrics.length()).contains(&pointer) {
            pointer - start
        } else {
            let half = metrics.length() / 2.;
            set(&presser, axis, metrics, pointer - half);
            half
        };
        down.update(cx, |g, _| *g = Some(grabbed));
        cx.stop_propagation();
    });
    window.on_mouse_event(move |event: &MouseMoveEvent, phase, _, cx| {
        let held = *drag.read(cx);
        if let (DispatchPhase::Bubble, Some(held), Some(metrics)) =
            (phase, held, Metrics::read(&mover, axis))
        {
            set(
                &mover,
                axis,
                metrics,
                along(event.position, axis) - origin - held,
            );
        }
    });
    window.on_mouse_event(move |_: &MouseUpEvent, _, _, cx| {
        up.update(cx, |g, _| *g = None);
    });
}

/// Moves the thumb's start to `start` px along the track and scrolls to match.
fn set(handle: &ScrollHandle, axis: Axis, metrics: Metrics, start: f32) {
    let travel = metrics.travel();
    if travel <= 0. {
        return;
    }
    let position = (start / travel).clamp(0., 1.) * metrics.max;
    let offset = handle.offset();
    handle.set_offset(match axis {
        Axis::X => point(px(-position), offset.y),
        Axis::Y => point(offset.x, px(-position)),
    });
}
