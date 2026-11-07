//! DS TaskGraphCanvas (TaskGraphCanvas.tsx, useSlotRects.ts, TaskGraphCanvas.module.css): a
//! read-only task DAG. Desktop: ranked columns left to right inside a horizontal scroller that
//! runs edge to edge; the first column rests on the inspector inset. Edges are painted paths
//! (satisfied, waiting, failed, into-running) with no motion. The selected task's column is
//! scrolled to the inset when it is out of view. Phone widths (`Orientation::Auto`, the
//! default): [`TaskGraphLanes`] inside an `InspectorInset`.
//!
//! [`layout`] is the pure layout the canvas and the lanes share, with the edge state and the
//! rolled-up graph status for containers.
pub(super) mod edges;
mod horizontal;
pub mod layout;
pub(super) mod nav;
pub(super) mod rects;
mod view;

use gpui::{App, IntoElement, ParentElement as _, RenderOnce, Window};

pub use self::layout::{TaskGraphEdge, rollup_status};
pub use self::view::{RenderNode, SelectHandler, TaskGraphNode, TaskGraphView};
use super::inspector_panel::InspectorInset;
use super::task_graph_lanes::TaskGraphLanes;
use crate::ui::context::Ds;

/// Which way the graph runs.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Orientation {
    /// Left to right, and lanes top to bottom at compact (phone) widths.
    #[default]
    Auto,
    /// Left to right at every width.
    Horizontal,
    /// Lanes top to bottom at every width.
    Vertical,
}

#[derive(IntoElement)]
pub struct TaskGraphCanvas {
    view: TaskGraphView,
    orientation: Orientation,
}

impl TaskGraphCanvas {
    pub fn new(view: TaskGraphView) -> Self {
        Self {
            view,
            orientation: Orientation::Auto,
        }
    }

    pub fn orientation(mut self, orientation: Orientation) -> Self {
        self.orientation = orientation;
        self
    }
}

impl RenderOnce for TaskGraphCanvas {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let vertical = match self.orientation {
            Orientation::Vertical => true,
            Orientation::Horizontal => false,
            Orientation::Auto => Ds::get(cx).compact(),
        };
        if vertical {
            InspectorInset::new()
                .child(TaskGraphLanes::new(self.view))
                .into_any_element()
        } else {
            horizontal::horizontal(&self.view, window, cx)
        }
    }
}
