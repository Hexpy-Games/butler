//! The props the canvas and the lanes share (`TaskGraphViewProps`).
use std::collections::HashMap;
use std::rc::Rc;

use gpui::{AnyElement, App, ElementId, SharedString, Window};

use super::layout::{GraphShape, TaskGraphEdge, cached_shape};
use crate::ui::blocks::task_graph_card::TaskGraphStatus;

/// Renders one task, normally a TaskGraphCard.
pub type RenderNode = Rc<dyn Fn(&SharedString, &mut Window, &mut App) -> AnyElement>;

/// Called with a task id when the arrow keys select it.
pub type SelectHandler = Rc<dyn Fn(&SharedString, &mut Window, &mut App)>;

/// A task of the graph: its id and the state its edges and lane dot read.
#[derive(Clone, Debug)]
pub struct TaskGraphNode {
    pub id: SharedString,
    pub status: TaskGraphStatus,
}

impl TaskGraphNode {
    pub fn new(id: impl Into<SharedString>, status: TaskGraphStatus) -> Self {
        Self {
            id: id.into(),
            status,
        }
    }
}

/// A read-only task DAG: nodes, prerequisite edges and how to draw a task. `id` keys the view's
/// state (measured rects, focus, scroll).
#[derive(Clone)]
pub struct TaskGraphView {
    pub(crate) id: ElementId,
    pub(crate) nodes: Vec<TaskGraphNode>,
    pub(crate) edges: Vec<TaskGraphEdge>,
    pub(crate) render_node: RenderNode,
    pub(crate) selected: Option<SharedString>,
    pub(crate) on_select: Option<SelectHandler>,
}

impl TaskGraphView {
    /// `edges`: from must finish before to; unknown ids are ignored.
    pub fn new(
        id: impl Into<ElementId>,
        nodes: Vec<TaskGraphNode>,
        edges: Vec<TaskGraphEdge>,
        render_node: impl Fn(&SharedString, &mut Window, &mut App) -> AnyElement + 'static,
    ) -> Self {
        Self {
            id: id.into(),
            nodes,
            edges,
            render_node: Rc::new(render_node),
            selected: None,
            on_select: None,
        }
    }

    /// The selected task: kept in view (canvas).
    pub fn selected(mut self, selected: Option<SharedString>) -> Self {
        self.selected = selected;
        self
    }

    /// Arrow keys move focus and call this with the new task.
    pub fn on_select(
        mut self,
        handler: impl Fn(&SharedString, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_select = Some(Rc::new(handler));
        self
    }

    pub(crate) fn shape(&self, window: &mut Window, cx: &mut App) -> Rc<GraphShape> {
        let ids: Vec<SharedString> = self.nodes.iter().map(|node| node.id.clone()).collect();
        cached_shape((self.id.clone(), "shape"), &ids, &self.edges, window, cx)
    }

    pub(crate) fn statuses(&self) -> HashMap<SharedString, TaskGraphStatus> {
        self.nodes
            .iter()
            .map(|node| (node.id.clone(), node.status))
            .collect()
    }
}
