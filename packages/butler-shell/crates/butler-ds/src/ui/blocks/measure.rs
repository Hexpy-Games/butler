//! Measuring a box: container queries and `ResizeObserver` read a box's own size, which gpui
//! knows only after layout. [`track`] returns the size the box had on the last frame and a
//! recorder to place inside the box (absolutely, filling it); a change asks for another frame.
use gpui::{
    AnyElement, App, Bounds, ElementId, IntoElement as _, Pixels, Size, Styled as _, Window,
    canvas, px,
};

/// How much a size may drift before it counts as changed.
const EPSILON: f32 = 0.5;

/// The last measured size of the box `id` (zero before the first frame) and its recorder.
pub fn track(
    id: impl Into<ElementId>,
    window: &mut Window,
    cx: &mut App,
) -> (Size<Pixels>, AnyElement) {
    let id = id.into();
    let state = window.use_keyed_state((id, "measure"), cx, |_, _| Size::<Pixels>::default());
    let seen = *state.read(cx);
    let recorder = canvas(
        |bounds: Bounds<Pixels>, _, _| bounds.size,
        move |_, size, window, cx| {
            let now = *state.read(cx);
            let moved = (now.width - size.width).abs() > px(EPSILON)
                || (now.height - size.height).abs() > px(EPSILON);
            if moved {
                state.update(cx, |state, _| *state = size);
                window.request_animation_frame();
            }
        },
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full()
    .into_any_element();
    (seen, recorder)
}
