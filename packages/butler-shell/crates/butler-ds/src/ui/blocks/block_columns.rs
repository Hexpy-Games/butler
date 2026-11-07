//! DS BlockColumns (BlockColumns.tsx / BlockColumns.module.css): two or three content blocks side
//! by side. It measures its own width, not the window's, so the same blocks stack in a narrow
//! place: two columns from 30rem, three from 40rem.
use gpui::{
    AnyElement, App, ElementId, IntoElement, ParentElement, RenderOnce, Styled as _, Window, div,
    px,
};

use super::measure;
use crate::tokens::Length;
use crate::ui::context::Ds;

/// `@container (width >= 30rem)` for two columns and `(width >= 40rem)` for three (rem is 16px).
const TWO_FROM: f32 = 480.; // DS: BlockColumns.module.css:24
const THREE_FROM: f32 = 640.; // DS: BlockColumns.module.css:30

#[derive(IntoElement)]
pub struct BlockColumns {
    id: ElementId,
    columns: Vec<AnyElement>,
}

impl BlockColumns {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            columns: Vec::new(),
        }
    }

    /// One content block per column; the first three count.
    pub fn child(mut self, column: impl IntoElement) -> Self {
        self.columns.push(column.into_any_element());
        self
    }
}

impl RenderOnce for BlockColumns {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let (size, recorder) = measure::track(self.id.clone(), window, cx);
        let ds = Ds::get(cx);
        let gap = ds.len(Length::SpaceMd);
        let width = f32::from(size.width);
        let count = self.columns.len().min(3);
        let across = match count {
            2 if width >= TWO_FROM => 2,
            3 if width >= THREE_FROM => 3,
            _ => 1,
        };
        let cell = |column: AnyElement| div().flex().flex_col().min_w_0().child(column);
        let mut rows = div().flex().flex_col().gap(gap).w_full();
        let mut cells = self.columns.into_iter().take(3).map(cell).peekable();
        while cells.peek().is_some() {
            let row = div().flex().gap(gap);
            rows = rows.child(cells.by_ref().take(across).fold(row, |row, cell| {
                row.child(div().flex_1().min_w(px(0.)).child(cell))
            }));
        }
        div().relative().w_full().child(recorder).child(rows)
    }
}
