//! A block scrap's live mini render (LibraryBlockPreview.tsx): the block laid out at RENDER_WIDTH,
//! scaled to the slot's width from its top start corner, its bottom edge fading rather than
//! cutting a row. It renders only once the card has come near the viewport, so a long 서랍 never
//! lays out every block at once.
use gpui::{
    AnyElement, App, Bounds, ElementId, Entity, IntoElement as _, ParentElement as _, Pixels,
    Styled as _, Window, canvas, div, linear_color_stop, linear_gradient, px, relative,
};

use crate::tokens::{Color, Length};
use crate::ui::context::Ds;

/// The width a block scrap is laid out at before it is scaled into the card (a phone-wide answer
/// column).
const RENDER_WIDTH: f32 = 480.; // DS: LibraryBlockPreview.tsx:5
/// `rootMargin: "50%"`: how far past the viewport a card counts as near, in viewport heights.
const NEAR_MARGIN: f32 = 0.5; // DS: LibraryBlockPreview.tsx:25
/// The mask keeps the block opaque down to 78% of the slot, then fades to clear.
const FADE_FROM: f32 = 0.78; // DS: LibraryCard.module.css:163
/// How much the measured width may drift before another frame is asked for.
const EPSILON: f32 = 0.5;

/// What the last frame saw of the slot: its width, and whether it has been near the viewport.
#[derive(Clone, Copy, Default)]
struct Seen {
    width: f32,
    near: bool,
}

pub(super) fn block(
    id: &ElementId,
    content: AnyElement,
    tagged: bool,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let state = window.use_keyed_state((id.clone(), "block"), cx, |_, _| Seen::default());
    let seen = *state.read(cx);
    let ds = Ds::get(cx);
    let top = if tagged {
        ds.len(Length::TagHeightSm) + ds.len(Length::SpaceSm)
    } else {
        px(0.)
    };
    let raised = ds.color(Color::SurfaceRaised);
    let clear = gpui::Hsla {
        alpha: 0.,
        ..raised
    };
    let scaled = (seen.near && seen.width > 0.).then(|| {
        div()
            .absolute()
            .top(top)
            .left_0()
            .w(px(RENDER_WIDTH))
            .p(ds.len(Length::SpaceMd))
            .scale(seen.width / RENDER_WIDTH)
            .transform_origin(0., 0.)
            .child(content)
    });
    let fade = div()
        .absolute()
        .left_0()
        .right_0()
        .bottom_0()
        .h(relative(1. - FADE_FROM))
        .bg(linear_gradient(
            180.,
            linear_color_stop(clear, 0.),
            linear_color_stop(raised, 1.),
        ));
    div()
        .relative()
        .size_full()
        .overflow_hidden()
        .child(recorder(state))
        .children(scaled)
        .child(fade)
        .into_any_element()
}

/// Records the slot's width and whether it is near the viewport; a change asks for one more
/// frame (the ResizeObserver and IntersectionObserver of the React block).
fn recorder(state: Entity<Seen>) -> AnyElement {
    canvas(
        |bounds, _, _| bounds,
        move |_, bounds: Bounds<Pixels>, window, cx| {
            let view = window.viewport_size().height;
            let margin = view * NEAR_MARGIN;
            let near = bounds.bottom() > -margin && bounds.top() < view + margin;
            let width = f32::from(bounds.size.width);
            let seen = *state.read(cx);
            if (seen.width - width).abs() > EPSILON || (near && !seen.near) {
                state.update(cx, |seen, _| {
                    seen.width = width;
                    seen.near |= near;
                });
                window.refresh();
            }
        },
    )
    .absolute()
    .size_full()
    .into_any_element()
}
