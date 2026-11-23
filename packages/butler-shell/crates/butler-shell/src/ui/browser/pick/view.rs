use super::geometry::n;
use crate::ui::{browser::model::Tab, widgets::anchor};
use butler_ds::ui::blocks::pick_outline::{PickOutline, PickOutlinePick, PickRect};
use butler_ds::ui::cover::cover;
use gpui::{
    AnyElement, App, DispatchPhase, ElementId, MouseMoveEvent, Pixels, SharedString, Size, Window,
    canvas, div, prelude::*, px,
};
use serde_json::Value;

#[expect(clippy::cast_possible_truncation, reason = "page dimensions fit f32")]
pub(crate) fn overlay(tab: &Tab, window: &mut Window, cx: &mut App) -> Option<AnyElement> {
    if !tab.picking && tab.selections.is_empty() {
        return None;
    }
    let layer = window.use_keyed_state(
        ElementId::Name(format!("browser-pick-layer-{}", tab.id.0).into()),
        cx,
        |_, _| Size::<Pixels>::default(),
    );
    let size = *layer.read(cx);
    let (width, height) = (f32::from(size.width), f32::from(size.height));
    let leave = tab.picking.then(|| tab.id.clone());
    let recorder = canvas(
        move |bounds, _, cx| {
            if *layer.read(cx) != bounds.size {
                layer.update(cx, |s, cx| {
                    *s = bounds.size;
                    cx.notify();
                });
            }
        },
        // The overlay covers exactly the page: a move outside it is the page's mouseLeave.
        move |bounds, (), window, _| {
            if let Some(id) = leave {
                window.on_mouse_event(move |e: &MouseMoveEvent, phase, _, cx| {
                    if phase == DispatchPhase::Bubble && !bounds.contains(&e.position) {
                        super::input::leave(&id, cx);
                    }
                });
            }
        },
    )
    .size_full();
    let vp = tab.pick.viewport();
    let scale = if vp.0 > 0. { width / vp.0 as f32 } else { 1. };
    let mut outline = PickOutline::new(
        SharedString::from(format!("browser-pick-outline-{}", tab.id.0)),
        width,
        height,
    )
    .scale(scale)
    .picks(tab.selections.iter().map(|p| {
        PickOutlinePick::new(
            p.data["id"].as_str().unwrap_or_default().to_owned(),
            rect(&p.data["rect"]),
        )
        .hidden(p.hidden)
    }));
    let marker = tab.pick_hover.as_ref().map(|h| {
        let r = rect(&h.rect);
        anchor(
            div()
                .absolute()
                .left(px(r.x * scale))
                .top(px(r.y * scale))
                .w(px(r.width * scale))
                .h(px(r.height * scale)),
            "browser-pick-hover",
        )
    });
    if let Some(h) = &tab.pick_hover {
        outline = outline.hover(rect(&h.rect)).hover_label(h.label.clone());
    }
    Some(
        anchor(div(), "browser-pick-overlay")
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .child(cover().child(recorder))
            .child(outline)
            .children(marker)
            .into_any_element(),
    )
}
#[expect(clippy::cast_possible_truncation, reason = "page rectangles fit f32")]
fn rect(value: &Value) -> PickRect {
    PickRect::new(
        n(value, "x") as f32,
        n(value, "y") as f32,
        n(value, "width") as f32,
        n(value, "height") as f32,
    )
}
