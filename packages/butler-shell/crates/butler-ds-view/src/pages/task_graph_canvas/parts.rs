//! TaskGraphCanvas.showcaseParts.tsx: the compositions the canvas, lanes and section pages share,
//! the same wiring the product container does (selection state, copy, a card per node): a graph
//! with its selection, and the Tasks tab body for several graphs.
use std::collections::HashSet;
use std::rc::Rc;

use butler_ds::ui::Icon;
use butler_ds::ui::blocks::task_graph_canvas::{
    Orientation, TaskGraphCanvas, TaskGraphEdge, TaskGraphNode, TaskGraphView, rollup_status,
};
use butler_ds::ui::blocks::task_graph_card::TaskGraphStatus;
use butler_ds::ui::blocks::task_graph_section::{TaskGraphPanel, TaskGraphSection};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Space, Stack};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, SharedString, Window};

use crate::copy::Lang;
use crate::pages::task_graph_card::data::{DemoGraph, GraphId};
use crate::pages::task_graph_card::demo::{
    demo_card, demo_copy, demo_counts, demo_detail, graphs_count,
};

type Select = Rc<dyn Fn(&SharedString, &mut Window, &mut App)>;

/// `demoNodes`.
fn nodes(graph: &DemoGraph) -> Vec<TaskGraphNode> {
    graph
        .tasks
        .iter()
        .map(|task| TaskGraphNode::new(task.id, task.status))
        .collect()
}

fn edges(graph: &DemoGraph) -> Vec<TaskGraphEdge> {
    graph
        .edges
        .iter()
        .map(|&(from, to)| TaskGraphEdge::new(from, to))
        .collect()
}

/// A graph with a card per task and no selection (the "plain renderNode" stories).
pub(crate) fn plain_view(key: &'static str, id: GraphId, lang: Lang) -> TaskGraphView {
    let graph = Rc::new(id.build());
    let source = graph.clone();
    TaskGraphView::new(
        key,
        nodes(&graph),
        edges(&graph),
        move |task_id, _, _| match source.task(task_id) {
            Some(task) => demo_card(task, lang).into_any_element(),
            None => Stack::new().into_any_element(),
        },
    )
}

fn first_selection(graph: &DemoGraph) -> Option<SharedString> {
    let by = |status| graph.tasks.iter().find(|task| task.status == status);
    by(TaskGraphStatus::Running)
        .or_else(|| by(TaskGraphStatus::Failed))
        .or_else(|| graph.tasks.first())
        .map(|task| SharedString::from(task.id))
}

/// `DemoGraphView`: one graph with selection, the canvas (or the lanes) and, with `detail`, the
/// selected task's detail. `scope` keeps the state of one story apart from another's.
pub(crate) fn graph_view(
    (scope, id, orientation): (&'static str, GraphId, Orientation),
    detail: bool,
    lang: Lang,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let graph = Rc::new(id.build());
    let key = format!("{scope}-{id:?}-{orientation:?}");
    let selected = window.use_keyed_state(key.clone(), cx, {
        let graph = graph.clone();
        move |_, _| first_selection(&graph)
    });
    let current = selected.read(cx).clone();
    let set: Select = {
        let selected = selected.clone();
        Rc::new(move |task, _, cx| {
            selected.update(cx, |selected, cx| {
                *selected = Some(task.clone());
                cx.notify();
            });
        })
    };
    let render = {
        let (graph, set, current) = (graph.clone(), set.clone(), current.clone());
        move |task_id: &SharedString, _: &mut Window, _: &mut App| match graph.task(task_id) {
            Some(task) => {
                let set = set.clone();
                demo_card(task, lang)
                    .selected(current.as_ref() == Some(task_id))
                    .on_activate(move |task, window, cx| set(task, window, cx))
                    .into_any_element()
            }
            None => Stack::new().into_any_element(),
        }
    };
    let on_select = set.clone();
    let view = TaskGraphView::new(key, nodes(&graph), edges(&graph), render)
        .selected(current.clone())
        .on_select(move |task, window, cx| on_select(task, window, cx));
    let detail = detail
        .then(|| current.as_ref().and_then(|task_id| graph.task(task_id)))
        .flatten()
        .map(|task| {
            demo_detail(&graph, task, lang)
                .on_select_task(move |task, window, cx| set(task, window, cx))
        });
    Stack::new()
        .gap(Space::Md)
        .child(TaskGraphCanvas::new(view).orientation(orientation))
        .children(detail)
        .into_any_element()
}

/// Panel order: running, failed, waiting, done, cancelled.
fn rank(status: TaskGraphStatus) -> usize {
    [
        TaskGraphStatus::Running,
        TaskGraphStatus::Failed,
        TaskGraphStatus::Pending,
        TaskGraphStatus::Done,
    ]
    .iter()
    .position(|&ranked| ranked == status)
    .unwrap_or(4)
}

/// `DemoPanel`: the Tasks tab body for several graphs, a TaskGraphSection per graph. Running and
/// failed graphs start open; with one graph there is no row.
pub(crate) fn panel(
    ids: &[GraphId],
    orientation: Orientation,
    lang: Lang,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let copy = demo_copy(lang);
    let mut graphs: Vec<(GraphId, DemoGraph, TaskGraphStatus)> = ids
        .iter()
        .map(|&id| {
            let graph = id.build();
            let statuses: Vec<_> = graph.tasks.iter().map(|task| task.status).collect();
            (id, graph, rollup_status(&statuses))
        })
        .collect();
    graphs.sort_by_key(|(_, _, status)| rank(*status));
    let state = window.use_keyed_state(format!("tg-panel-{ids:?}"), cx, {
        let start: HashSet<&'static str> = graphs
            .iter()
            .filter(|(_, _, status)| {
                matches!(status, TaskGraphStatus::Running | TaskGraphStatus::Failed)
            })
            .map(|(_, graph, _)| graph.id)
            .collect();
        move |_, _| start
    });
    let single = graphs.len() == 1;
    let running = graphs
        .iter()
        .filter(|(_, _, status)| *status == TaskGraphStatus::Running)
        .count();
    let mut panel = TaskGraphPanel::new(copy.panel, copy.empty)
        .icon(icon(Icon::Blocks, IconSize::Md, Ds::get(cx)))
        .empty(graphs.is_empty());
    match graphs.first() {
        Some((_, graph, _)) if single => {
            panel = panel
                .description(graph.title.get(lang))
                .header_meta(demo_counts(graph, lang));
        }
        Some(_) => panel = panel.header_meta(graphs_count(lang, graphs.len(), running)),
        None => {}
    }
    for (id, graph, status) in &graphs {
        let (open, graph_id) = (state.read(cx).contains(graph.id), graph.id);
        let toggle = state.clone();
        panel = panel.child(
            TaskGraphSection::new(graph.id, graph.title.get(lang), *status)
                .meta(demo_counts(graph, lang))
                .collapsible(!single)
                .open(open)
                .on_toggle(move |_, cx| {
                    toggle.update(cx, |open, cx| {
                        if !open.remove(graph_id) {
                            open.insert(graph_id);
                        }
                        cx.notify();
                    });
                })
                .child(graph_view(
                    ("tg-panel", *id, orientation),
                    true,
                    lang,
                    window,
                    cx,
                )),
        );
    }
    panel.into_any_element()
}
