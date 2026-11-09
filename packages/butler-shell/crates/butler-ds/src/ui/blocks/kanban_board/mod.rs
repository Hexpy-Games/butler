//! DS KanbanBoard (`blocks/KanbanBoard/`): lanes side by side ([`KanbanBoard`], [`KanbanLane`]),
//! cards in them ([`KanbanCard`]) and, inside a [`KanbanDragScope`], cards that move within a
//! lane, between lanes and between boards by pointer or keyboard. The product owns the order:
//! [`KanbanDragScope::on_move`] reports a [`KanbanMove`], [`apply_kanban_move`] applies it.
//!
//! The drag reuses the mechanism of `SortableCardList`: a gpui pointer drag carries the card, a
//! shared session records the lanes and cards as they paint, and a lifted copy follows the
//! pointer. Not reproduced: motion that needs a frame loop or a layout animation
//! (`// ANIM-MIGRATE`, see `scope.rs` and `lifted.rs`), the drop animation, the edge-band
//! auto-scroll, the board's hover-only classic scrollbar (`ScrollArea`'s overlay thumb stands in)
//! and the screen-reader live region (announcements go to `on_announce`).
mod card;
mod frame;
mod labels;
mod lane;
mod lifted;
mod model;
mod scope;
mod session;

use gpui::{
    AnyElement, ElementId, IntoElement, ParentElement, RenderOnce, Styled as _, Window, div,
};

pub use card::KanbanCard;
pub use labels::KanbanDragLabels;
pub use lane::{KanbanLane, LaneHeight};
pub use model::{KanbanDropTarget, KanbanLanes, KanbanMove, LaneLayout, apply_kanban_move};
pub use scope::KanbanDragScope;

use crate::tokens::Length;
use crate::ui::context::Ds;
use crate::ui::layout::{Columns, Grid, Space};
use crate::ui::scroll::{Axis, ScrollArea};

/// `GridColumnPreset`: one column per lane (default four).
pub type GridColumns = Columns;

/// Lanes side by side; each lane is a [`KanbanLane`] (or another lane surface).
#[derive(IntoElement)]
pub struct KanbanBoard {
    id: ElementId,
    columns: GridColumns,
    scroll: bool,
    children: Vec<AnyElement>,
}

impl KanbanBoard {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            columns: Columns::fixed(4),
            scroll: false,
            children: Vec::new(),
        }
    }

    /// One column per lane (default four). Ignored with `scroll`.
    pub fn columns(mut self, columns: GridColumns) -> Self {
        self.columns = columns;
        self
    }

    /// Keep every lane in one row at least `--kanban-lane-min-width` wide; the board scrolls
    /// sideways with the x scroll-edge fade instead of wrapping.
    pub fn scroll(mut self, scroll: bool) -> Self {
        self.scroll = scroll;
        self
    }
}

impl ParentElement for KanbanBoard {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for KanbanBoard {
    fn render(self, _: &mut Window, cx: &mut gpui::App) -> impl IntoElement {
        if !self.scroll {
            return Grid::new((self.id, "grid"))
                .columns(self.columns)
                .gap(Space::Md)
                .fill_cells()
                .children(self.children)
                .into_any_element();
        }
        let ds = Ds::get(cx);
        let (gap, min) = (Space::Md.px(ds), ds.len(Length::KanbanLaneMinWidth));
        let lanes = self.children.into_iter().enumerate().map(|(index, lane)| {
            let mut cell = div()
                .flex_grow_1()
                .flex_shrink_0()
                .flex_basis(min)
                .min_w(min)
                .child(lane);
            if index > 0 {
                cell = cell.ml(gap);
            }
            cell
        });
        ScrollArea::new((self.id, "scroll"))
            .orientation(Axis::X)
            .children(lanes)
            .into_any_element()
    }
}
