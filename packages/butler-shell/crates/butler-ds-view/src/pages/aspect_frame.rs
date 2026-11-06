//! AspectFrame.showcase.tsx: a static canvas drawing (the thinking mark animates the same way).
use butler_ds::ui::aspect_frame::AspectFrame;
use butler_ds::ui::icon::IconSize;
use butler_ds::ui::layout::{Cross, Space, Stack};
use gpui::{
    AnyElement, App, IntoElement as _, PaintQuad, ParentElement as _, Styled as _, Window, canvas,
    point, px, size,
};

use super::Story;
use crate::copy::Lang;

pub(super) fn stories() -> Vec<Story> {
    vec![Story {
        name: "Fixed sizes and fill",
        render: frames,
    }]
}

/// The `Dot`: a disc of 24/64 of the frame, in the text colour.
fn dot() -> AnyElement {
    canvas(
        |_, _, _| (),
        |bounds, (), window, _| {
            let side = bounds.size.width.min(bounds.size.height);
            let radius = side * (24. / 64.);
            let centre = bounds.center();
            let disc = gpui::Bounds::new(
                point(centre.x - radius, centre.y - radius),
                size(radius * 2., radius * 2.),
            );
            let ink = window.text_style().color;
            window.paint_quad(
                PaintQuad::new(disc)
                    .background(ink)
                    .corner_radii(px(f32::from(radius))),
            );
        },
    )
    .size_full()
    .into_any_element()
}

fn frames(_: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let frame = |size| AspectFrame::new().size(size).child(dot());
    Stack::row()
        .cross(Cross::End)
        .gap(Space::Md)
        .child(frame(IconSize::Sm))
        .child(frame(IconSize::Lg))
        .child(frame(IconSize::Xxl))
        .into_any_element()
}
