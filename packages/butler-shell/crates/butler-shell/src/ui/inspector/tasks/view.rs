//! `TaskGraphView`: one plan graph as a section with its canvas and the selected task's detail.
use std::collections::HashMap;
use std::rc::Rc;

use butler_ds::ui::blocks::task_graph_canvas::{
    TaskGraphCanvas, TaskGraphEdge, TaskGraphNode, TaskGraphView,
};
use butler_ds::ui::blocks::task_graph_card::{TaskGraphCard, TaskGraphStatus};
use butler_ds::ui::blocks::task_graph_section::TaskGraphSection;
use butler_ds::ui::context::Lang;
use gpui::{AnyElement, App, ElementId, IntoElement as _, ParentElement as _, SharedString, Window};

use super::detail::task_node_detail;
use super::present::{
    graph_assignee, graph_elapsed, graph_meta, graph_section_status, graph_status_label,
    graph_task_status,
};
use super::{Actions, task_graph_clock};
use crate::ui::i18n::task_graph as copy;
use crate::ui::source::wire::{TaskGraphSnapshotWire, TaskGraphStatusWire};

/// What `renderNode` draws a card from.
struct Card {
    title: SharedString,
    status: TaskGraphStatus,
    status_label: SharedString,
    meta: SharedString,
    time: Option<SharedString>,
    step: Option<SharedString>,
    session: Option<String>,
}

type Cards = Rc<HashMap<SharedString, Card>>;
type Activate = Rc<dyn Fn(&SharedString, &mut Window, &mut App)>;

/// What `renderNode` draws each task from.
fn build_cards(graph: &TaskGraphSnapshotWire, lang: Lang, now: i64) -> Cards {
    let words = copy::words(lang);
    Rc::new(
        graph
            .nodes
            .iter()
            .map(|n| {
                let meta = [Some(graph_assignee(lang, words, n)), n.model_display_name.clone()];
                let card = Card {
                    title: n.title.clone().into(),
                    status: graph_task_status(n),
                    status_label: graph_status_label(words, n).into(),
                    meta: meta
                        .into_iter()
                        .flatten()
                        .filter(|part| !part.is_empty())
                        .collect::<Vec<_>>()
                        .join(" · ")
                        .into(),
                    time: graph_elapsed(lang, n, now).map(Into::into),
                    step: n.current_step.clone().map(Into::into),
                    session: n.session_id.clone(),
                };
                (SharedString::from(n.task_id.clone()), card)
            })
            .collect(),
    )
}

/// `renderNode`: a TaskGraphCard for a task.
fn card_renderer(
    cards: Cards,
    selected: Option<SharedString>,
    activate: Activate,
) -> impl Fn(&SharedString, &mut Window, &mut App) -> AnyElement + 'static {
    move |id, _, _| {
        let Some(card) = cards.get(id) else {
            return gpui::Empty.into_any_element();
        };
        let activate = activate.clone();
        let mut view = TaskGraphCard::new(
            id.clone(),
            card.title.clone(),
            card.status,
            card.status_label.clone(),
        )
        .meta(card.meta.clone())
        .selected(selected.as_ref() == Some(id))
        .on_activate(move |id, window, cx| activate(id, window, cx));
        if let Some(time) = &card.time {
            view = view.time(time.clone());
        }
        if let Some(step) = &card.step {
            view = view.step(step.clone());
        }
        view.into_any_element()
    }
}

/// `TaskGraphView`
pub(super) fn task_graph_view(
    graph: &TaskGraphSnapshotWire,
    selected: Option<&str>,
    open: bool,
    single: bool,
    actions: &Rc<Actions>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let lang = actions.lang;
    let words = copy::words(lang);
    let graph_id = SharedString::from(graph.summary.graph_id.clone());
    let running = graph.nodes.iter().any(|n| n.status == TaskGraphStatusWire::Running);
    let now = task_graph_clock(ElementId::from(format!("{graph_id}-clock")), running, window, cx);
    let nodes: Vec<TaskGraphNode> = graph
        .nodes
        .iter()
        .map(|n| TaskGraphNode::new(n.task_id.clone(), graph_task_status(n)))
        .collect();
    let edges: Vec<TaskGraphEdge> = graph
        .edges
        .iter()
        .map(|e| TaskGraphEdge::new(e.from.clone(), e.to.clone()))
        .collect();
    let cards = build_cards(graph, lang, now);
    let selected_id = selected.map(|id| SharedString::from(id.to_owned()));
    let activate: Activate = {
        let (cards, actions) = (cards.clone(), actions.clone());
        Rc::new(move |id: &SharedString, _: &mut Window, cx: &mut App| {
            actions.select(id, cx);
            if let Some(session) = cards.get(id).and_then(|card| card.session.as_deref()) {
                actions.open_session(session, cx);
            }
        })
    };
    let render_node = card_renderer(cards, selected_id.clone(), activate);
    let on_select = {
        let actions = actions.clone();
        move |id: &SharedString, _: &mut Window, cx: &mut App| actions.select(id, cx)
    };
    let canvas = TaskGraphCanvas::new(
        TaskGraphView::new(
            ElementId::from(format!("{graph_id}-canvas")),
            nodes,
            edges,
            render_node,
        )
        .selected(selected_id)
        .on_select(on_select),
    );
    let detail = selected
        .and_then(|id| graph.nodes.iter().find(|n| n.task_id == id))
        .map(|node| task_node_detail(node, graph, now, actions));
    let toggle = {
        let (actions, id) = (actions.clone(), graph.summary.graph_id.clone());
        move |_: &mut Window, cx: &mut App| actions.toggle(&id, cx)
    };
    TaskGraphSection::new(graph_id, graph.summary.title.clone(), graph_section_status(graph))
        .meta(graph_meta(lang, words, graph))
        .collapsible(!single)
        .open(open)
        .on_toggle(toggle)
        .child(canvas)
        .children(detail)
        .into_any_element()
}
