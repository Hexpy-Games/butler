//! The desktop layout (`HorizontalGraph`): ranked columns left to right inside a horizontal
//! scroller, edges painted under the cards, arrow keys, and the selected task's column scrolled
//! to the inset when it is out of view.
use std::collections::HashMap;
use std::rc::Rc;

use gpui::{
    AnyElement, App, Div, ElementId, Entity, FocusHandle, InteractiveElement as _,
    IntoElement as _, KeyDownEvent, ParentElement as _, Pixels, Point, ScrollHandle, SharedString,
    Styled as _, Window, div, point, px, relative,
};

use super::edges::{self, EdgePalette};
use super::layout::{GraphShape, TaskGraphSlot, edge_state};
use super::nav;
use super::rects::{self, Measure};
use super::view::{SelectHandler, TaskGraphView};
use crate::tokens::{Color, Length};
use crate::ui::blocks::task_graph_card::TaskGraphStatus;
use crate::ui::context::Ds;
use crate::ui::convert;
use crate::ui::layout::Space;
use crate::ui::scroll::{self, Axis, Config};

/// `--task-graph-card-width`.
const CARD_WIDTH: f32 = 208.; // DS: TaskGraphCanvas.module.css:3
/// The scrollbar lane is never narrower than this (DS: ScrollArea.module.css:15).
const LANE_MIN: f32 = 10.;
/// The thumb's share of `--line-strong` (as ScrollArea).
const THUMB_SHARE: f32 = 0.7;

pub(super) fn horizontal(view: TaskGraphView, window: &mut Window, cx: &mut App) -> AnyElement {
    let shape = view.shape(window, cx);
    let measure = rects::state((view.id.clone(), "rects"), window, cx);
    let handles = nav::handles(&view.id, shape.order(), window, cx);
    let first_line = rects::card_first_line(window, cx);
    let palette = EdgePalette::of(Ds::get(cx));
    let statuses = view.statuses();
    let columns = columns(&view, &shape, (&measure, &handles, first_line), window, cx);
    let edges = {
        let shape = shape.clone();
        rects::origin(&measure, move |origin, measured, window| {
            paint_routes(&shape, &statuses, (palette, origin), measured, window);
        })
    };
    let (pad, gap) = {
        let ds = Ds::get(cx);
        (Space::Xs.px(ds), ds.len(Length::Space4xl))
    };
    let host = div()
        .relative()
        .flex_none()
        .p(pad)
        .on_key_down(on_keys(shape.clone(), handles, view.on_select.clone()))
        .child(edges)
        .child(
            div()
                .relative()
                .flex()
                .items_center()
                .gap(gap)
                .children(columns),
        );
    let scroll_id = ElementId::from((view.id.clone(), "scroll"));
    let (frame, handle) = scroll_x(&scroll_id, host, window, cx);
    reveal_selected(&view, &shape, (&measure, &handle), window, cx);
    frame
}

fn columns(
    view: &TaskGraphView,
    shape: &GraphShape,
    (measure, handles, first_line): (&Entity<Measure>, &[(SharedString, FocusHandle)], f32),
    window: &mut Window,
    cx: &mut App,
) -> Vec<Div> {
    let focus: HashMap<&SharedString, &FocusHandle> =
        handles.iter().map(|(id, handle)| (id, handle)).collect();
    let (row_gap, dummy) = {
        let ds = Ds::get(cx);
        (Space::Md.px(ds), Space::Lg.px(ds))
    };
    let mut out = Vec::new();
    for column in &shape.columns.columns {
        let mut col = div()
            .flex()
            .flex_col()
            .flex_none()
            .w(px(CARD_WIDTH))
            .gap(row_gap);
        for slot in column {
            col = col.child(match slot {
                TaskGraphSlot::Node(id) => {
                    let content = (view.render_node)(id, window, cx);
                    let handle = focus.get(id).copied();
                    rects::slot((id, handle), measure, Some(first_line), content)
                }
                TaskGraphSlot::Dummy(id) => {
                    rects::slot((id, None), measure, None, div().h(dummy).into_any_element())
                }
            });
        }
        out.push(col);
    }
    out
}

/// One cubic per hop between slots; a rank-skipping edge runs straight through each dummy.
fn paint_routes(
    shape: &GraphShape,
    statuses: &HashMap<SharedString, TaskGraphStatus>,
    (palette, origin): (EdgePalette, Point<Pixels>),
    measured: &Measure,
    window: &mut Window,
) {
    for route in &shape.columns.routes {
        let points: Option<Vec<_>> = route.slots.iter().map(|id| measured.rect(id)).collect();
        let (Some(points), Some(&from), Some(&to)) =
            (points, statuses.get(&route.from), statuses.get(&route.to))
        else {
            continue;
        };
        let Some(first) = points.first() else {
            continue;
        };
        let (mut builder, color) = palette.stroke(edge_state(from, to));
        builder.move_to(rects::at(origin, first.right, first.mid_y));
        for (i, pair) in points.windows(2).enumerate() {
            let (a, b) = (pair[0], pair[1]);
            let bend = ((b.left - a.right) / 2.).max(12.);
            builder.cubic_bezier_to(
                rects::at(origin, b.left, b.mid_y),
                rects::at(origin, a.right + bend, a.mid_y),
                rects::at(origin, b.left - bend, b.mid_y),
            );
            if i + 2 < points.len() {
                builder.line_to(rects::at(origin, b.right, b.mid_y));
            }
        }
        edges::paint(window, builder, color);
    }
}

/// The ids of the node slots of column `column`.
fn tasks(columns: &[Vec<TaskGraphSlot>], column: Option<usize>) -> Vec<&SharedString> {
    column
        .and_then(|c| columns.get(c))
        .into_iter()
        .flatten()
        .filter_map(|slot| match slot {
            TaskGraphSlot::Node(id) => Some(id),
            TaskGraphSlot::Dummy(_) => None,
        })
        .collect()
}

/// Right and left follow edges (else the neighbouring column's first task); up and down stay in
/// the column.
fn arrow_target(shape: &GraphShape, id: &SharedString, key: &str) -> Option<SharedString> {
    let columns = &shape.columns.columns;
    let column = columns
        .iter()
        .position(|slots| slots.iter().any(|slot| slot.id() == id))?;
    let here = tasks(columns, Some(column));
    let at = here.iter().position(|task| *task == id)?;
    let next = match key {
        "right" => shape
            .index
            .succs_of(id)
            .first()
            .or_else(|| tasks(columns, Some(column + 1)).first().copied()),
        "left" => shape
            .index
            .preds_of(id)
            .first()
            .or_else(|| tasks(columns, column.checked_sub(1)).first().copied()),
        "down" => here.get(at + 1).copied(),
        "up" => at.checked_sub(1).and_then(|i| here.get(i).copied()),
        _ => None,
    };
    next.cloned()
}

fn on_keys(
    shape: Rc<GraphShape>,
    handles: Vec<(SharedString, FocusHandle)>,
    on_select: Option<SelectHandler>,
) -> impl Fn(&KeyDownEvent, &mut Window, &mut App) + 'static {
    move |event, window, cx| {
        let Some(here) = nav::focused(&handles, window, cx) else {
            return;
        };
        let Some(next) = arrow_target(&shape, &here, event.keystroke.key.as_str()) else {
            return;
        };
        nav::move_focus(shape.order(), (&here, &next), window, cx);
        if let Some(select) = &on_select {
            select(&next, window, cx);
        }
        cx.stop_propagation();
    }
}

/// The fading horizontal scroller of ScrollArea, built here because the canvas needs its scroll
/// handle (ScrollArea keeps it private).
fn scroll_x(
    id: &ElementId,
    content: Div,
    window: &mut Window,
    cx: &mut App,
) -> (AnyElement, ScrollHandle) {
    let (room, fade, guard, thumb) = {
        let ds = Ds::get(cx);
        (
            ds.len(Length::FocusRingRoom),
            ds.len(Length::ScrollFadeSize),
            ds.len(Length::SpaceXs),
            convert::with_alpha(ds.color(Color::LineStrong), THUMB_SHARE),
        )
    };
    let column = div()
        .flex()
        .flex_row()
        .flex_none()
        .min_w(relative(1.))
        .py(room)
        .px(fade)
        .child(content);
    let scroller = div()
        .flex()
        .flex_col()
        .w_full()
        .min_w_0()
        .min_h_0()
        .child(column);
    let config = Config {
        id: id.clone(),
        axis: Axis::X,
        size: fade,
        guard,
    };
    let built = scroll::scroller(&config, scroller, window, cx);
    let overlay = scroll::overlay(
        id,
        &built,
        (Axis::X, px(LANE_MIN).max(room)),
        thumb,
        window,
        cx,
    );
    let frame = div()
        .id(id.clone())
        .relative()
        .min_w_0()
        .min_h_0()
        .overflow_hidden()
        .max_w_full()
        .my(-room)
        .child(built.element)
        .child(overlay);
    (frame.into_any_element(), built.handle)
}

/// An out-of-view selection scrolls so its column rests where the first column rests (the inset).
fn reveal_selected(
    view: &TaskGraphView,
    shape: &GraphShape,
    (measure, handle): (&Entity<Measure>, &ScrollHandle),
    window: &mut Window,
    cx: &mut App,
) {
    let revealed =
        window.use_keyed_state(
            (view.id.clone(), "revealed"),
            cx,
            |_, _| None::<SharedString>,
        );
    let Some(selected) = view
        .selected
        .as_ref()
        .filter(|id| shape.order().contains(id))
    else {
        if revealed.read(cx).is_some() {
            revealed.update(cx, |revealed, _| *revealed = None);
        }
        return;
    };
    if revealed.read(cx).as_ref() == Some(selected) {
        return;
    }
    let measured = measure.read(cx);
    let first = shape
        .columns
        .columns
        .first()
        .and_then(|column| column.first())
        .and_then(|slot| measured.rect(slot.id()));
    let viewport = handle.bounds();
    let (Some(card), Some(first), true) =
        (measured.rect(selected), first, viewport.size.width > px(0.))
    else {
        window.request_animation_frame();
        return;
    };
    let (left, right) = (
        measured.origin.x + px(card.left),
        measured.origin.x + px(card.right),
    );
    if left < viewport.left() || right > viewport.right() {
        let farthest = f32::from(handle.max_offset().x).max(0.);
        let target = (card.left - first.left).clamp(0., farthest);
        handle.set_offset(point(px(-target), handle.offset().y));
        window.request_animation_frame();
    }
    revealed.update(cx, |revealed, _| *revealed = Some(selected.clone()));
}
