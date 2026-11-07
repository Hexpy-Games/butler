//! DS TaskGraphLanes (TaskGraphLanes.tsx / TaskGraphLanes.module.css): the phone layout of a task
//! DAG. Tasks run top to bottom in rank order at full width, with a lane gutter that carries
//! fan-out and join (git-log lanes). Each dot sits on its card's first text line (the centre of
//! the card's IconSlot). Up and Down move focus and selection row by row.
use std::collections::HashMap;
use std::rc::Rc;

use gpui::{
    App, FocusHandle, Hsla, InteractiveElement as _, IntoElement, KeyDownEvent, ParentElement as _,
    PathBuilder, Pixels, Point, RenderOnce, SharedString, Styled as _, Window, div, point, px,
};

use super::task_graph_canvas::layout::{GraphShape, edge_key, edge_state};
use super::task_graph_canvas::{SelectHandler, TaskGraphView};
use super::task_graph_canvas::{
    edges::{self, EdgePalette},
    nav,
    rects::{self, Measure},
};
use super::task_graph_card::TaskGraphStatus;
use crate::tokens::Color;
use crate::ui::arc;
use crate::ui::context::Ds;
use crate::ui::layout::Space;

/// Distance between lanes.
const PITCH: f32 = 14.; // DS: TaskGraphLanes.tsx:7
/// Inset of the first lane.
const PAD: f32 = 7.; // DS: TaskGraphLanes.tsx:8
/// How far an edge bends in or out of its lane.
const BEND: f32 = 8.; // DS: TaskGraphLanes.tsx:9
/// A dot's radius, larger while running.
const DOT: f32 = 3.5; // DS: TaskGraphLanes.tsx:41
const DOT_RUNNING: f32 = 4.5; // DS: TaskGraphLanes.tsx:41
const DOT_STROKE: f32 = 1.25; // DS: TaskGraphLanes.module.css:34

#[derive(IntoElement)]
pub struct TaskGraphLanes {
    view: TaskGraphView,
}

impl TaskGraphLanes {
    pub fn new(view: TaskGraphView) -> Self {
        Self { view }
    }
}

/// The dot colours by status (`.dot`).
#[derive(Clone, Copy)]
struct DotPalette {
    edge: EdgePalette,
    raised: Hsla,
    active: Hsla,
    danger: Hsla,
    warning: Hsla,
    accent: Hsla,
}

impl DotPalette {
    fn of(ds: &Ds) -> Self {
        Self {
            edge: EdgePalette::of(ds),
            raised: ds.color(Color::SurfaceRaised),
            active: ds.color(Color::WorkerActive),
            danger: ds.color(Color::Danger),
            warning: ds.color(Color::ColorWarning),
            accent: ds.color(Color::Accent),
        }
    }

    /// Fill and stroke of a dot.
    fn dot(&self, status: TaskGraphStatus) -> (Hsla, Hsla) {
        let line = self.edge.line;
        match status {
            TaskGraphStatus::Running => (self.active, self.active),
            TaskGraphStatus::Done => (line, line),
            TaskGraphStatus::Failed => (self.danger, self.danger),
            TaskGraphStatus::Blocked => (self.warning, self.warning),
            TaskGraphStatus::Review => (self.accent, self.accent),
            _ => (self.raised, line),
        }
    }
}

impl RenderOnce for TaskGraphLanes {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let view = self.view;
        let shape = view.shape(window, cx);
        let measure = rects::state((view.id.clone(), "rects"), window, cx);
        let handles = nav::handles(&view.id, shape.order(), window, cx);
        let first_line = rects::card_first_line(window, cx);
        let palette = DotPalette::of(Ds::get(cx));
        let statuses = view.statuses();
        let width = PAD * 2. + (shape.lanes.lane_count - 1) as f32 * PITCH;
        let gutter = {
            let shape = shape.clone();
            rects::origin(&measure, move |origin, measured, window| {
                paint_gutter(&shape, &statuses, palette, (origin, measured), window);
            })
        };
        let mut rows = Vec::new();
        for id in shape.order() {
            let content = (view.render_node)(id, window, cx);
            let handle = handles
                .iter()
                .find(|(held, _)| held == id)
                .map(|(_, handle)| handle);
            rows.push(rects::slot(
                (id, handle),
                &measure,
                Some(first_line),
                content,
            ));
        }
        let gap = Space::Sm.px(Ds::get(cx));
        div()
            .relative()
            .flex()
            .items_start()
            .gap(gap)
            .min_w_0()
            .on_key_down(on_keys(shape, handles, view.on_select.clone()))
            .child(div().relative().flex_none().w(px(width)).child(gutter))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .gap(gap)
                    .children(rows),
            )
    }
}

fn paint_gutter(
    shape: &GraphShape,
    statuses: &HashMap<SharedString, TaskGraphStatus>,
    palette: DotPalette,
    (origin, measured): (Point<Pixels>, &Measure),
    window: &mut Window,
) {
    let rows = &shape.lanes.rows;
    if !rows.iter().all(|id| measured.rect(id).is_some()) {
        return;
    }
    let lane = |id: &SharedString| shape.lanes.lane.get(id).copied().unwrap_or(0);
    let x = |lane: usize| PAD + lane as f32 * PITCH;
    let y = |id: &SharedString| measured.rect(id).map_or(0., |rect| rect.first_line_y);
    for from in &shape.index.ids {
        for to in shape.index.succs_of(from) {
            let key = edge_key(from, to);
            let travel = shape
                .lanes
                .edge_lane
                .get(&key)
                .copied()
                .unwrap_or_else(|| lane(to));
            let (xp, xl, xs) = (x(lane(from)), x(travel), x(lane(to)));
            let (yp, ys) = (y(from), y(to));
            let (Some(&a), Some(&b)) = (statuses.get(from), statuses.get(to)) else {
                continue;
            };
            let (mut path, color) = palette.edge.stroke(edge_state(a, b));
            let at = |x: f32, y: f32| rects::at(origin, x, y);
            path.move_to(at(xp, yp));
            if xl != xp {
                path.cubic_bezier_to(at(xl, yp + 2. * BEND), at(xp, yp + BEND), at(xl, yp + BEND));
            }
            if xl == xs {
                path.line_to(at(xl, ys));
            } else {
                path.line_to(at(xl, ys - 2. * BEND));
                path.cubic_bezier_to(at(xs, ys), at(xl, ys - BEND), at(xs, ys - BEND));
            }
            edges::paint(window, path, color);
        }
    }
    for id in rows {
        let Some(&status) = statuses.get(id) else {
            continue;
        };
        let radius = if status == TaskGraphStatus::Running {
            DOT_RUNNING
        } else {
            DOT
        };
        let (fill, stroke) = palette.dot(status);
        let center = rects::at(origin, x(lane(id)), y(id));
        disc(window, center, radius, fill);
        arc::ring(window, center, radius, DOT_STROKE, stroke);
    }
}

/// A filled circle.
fn disc(window: &mut Window, center: Point<Pixels>, radius: f32, color: Hsla) {
    let steps = 24;
    let mut path = PathBuilder::fill();
    for i in 0..steps {
        let angle = i as f32 / steps as f32 * std::f32::consts::TAU;
        let p = point(
            center.x + px(radius * angle.cos()),
            center.y + px(radius * angle.sin()),
        );
        if i == 0 {
            path.move_to(p);
        } else {
            path.line_to(p);
        }
    }
    path.close();
    if let Ok(path) = path.build() {
        window.paint_path(path, color);
    }
}

fn on_keys(
    shape: Rc<GraphShape>,
    handles: Vec<(SharedString, FocusHandle)>,
    on_select: Option<SelectHandler>,
) -> impl Fn(&KeyDownEvent, &mut Window, &mut App) + 'static {
    move |event, window, cx| {
        let step: isize = match event.keystroke.key.as_str() {
            "down" => 1,
            "up" => -1,
            _ => return,
        };
        let Some(here) = nav::focused(&handles, window, cx) else {
            return;
        };
        let rows = shape.order();
        let next = rows
            .iter()
            .position(|id| *id == here)
            .and_then(|at| at.checked_add_signed(step))
            .and_then(|at| rows.get(at))
            .cloned();
        let Some(next) = next else {
            return;
        };
        nav::move_focus(rows, (&here, &next), window, cx);
        if let Some(select) = &on_select {
            select(&next, window, cx);
        }
        cx.stop_propagation();
    }
}
