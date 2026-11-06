//! `Field` and `FieldContent`: a label, a description and a control, stacked, or in a row with
//! the control at the end centred on the label's line.
use gpui::{
    AnyElement, App, ElementId, Entity, IntoElement, ParentElement, Pixels, RenderOnce,
    Styled as _, Window, canvas, div, px,
};

use crate::tokens::Length;
use crate::ui::context::Ds;
use crate::ui::strut;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Orientation {
    #[default]
    Vertical,
    /// A row, centred. With a [`FieldContent`] the control sits at the row end, centred on the
    /// content's first line.
    Horizontal,
    /// A column, and a centred row from 768px wide.
    Responsive,
}

/// `FieldContent`: a column of a label and a description, `flex: 1`.
pub struct FieldContent {
    children: Vec<AnyElement>,
}

impl FieldContent {
    pub fn new() -> Self {
        Self {
            children: Vec::new(),
        }
    }
}

impl Default for FieldContent {
    fn default() -> Self {
        Self::new()
    }
}

impl ParentElement for FieldContent {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

enum Child {
    Content(FieldContent),
    Other(AnyElement),
}

/// The gap between the content's rows (DS: Field.module.css:53).
const CONTENT_GAP: f32 = 2.;
/// The viewport width from which a responsive field is a row (DS: Field.module.css:147).
const RESPONSIVE_ROW: f32 = 768.;

#[derive(IntoElement)]
pub struct Field {
    id: ElementId,
    orientation: Orientation,
    children: Vec<Child>,
}

impl Field {
    /// `id` keys the measure a horizontal field takes of its control.
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            orientation: Orientation::Vertical,
            children: Vec::new(),
        }
    }

    pub fn orientation(mut self, orientation: Orientation) -> Self {
        self.orientation = orientation;
        self
    }

    /// The label and description column.
    pub fn content(mut self, content: FieldContent) -> Self {
        self.children.push(Child::Content(content));
        self
    }
}

impl ParentElement for Field {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements.into_iter().map(Child::Other));
    }
}

/// The content's rows in a column with the gap between them and the label line height.
fn column(content: FieldContent, ds: &Ds) -> gpui::Div {
    div()
        .flex()
        .flex_col()
        .flex_1()
        .min_w_0()
        .gap(px(CONTENT_GAP))
        .line_height(ds.len(Length::TypoLabelLineHeight))
        .children(
            content
                .children
                .into_iter()
                .map(|child| strut::flex_scope(true, child)),
        )
}

impl RenderOnce for Field {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let wide = ds.tokens().viewport.0 >= RESPONSIVE_ROW;
        let row = match self.orientation {
            Orientation::Vertical => false,
            Orientation::Horizontal => true,
            Orientation::Responsive => wide,
        };
        let has_content = self.children.iter().any(|c| matches!(c, Child::Content(_)));
        let field = div().flex().w_full().min_w_0().gap(ds.len(Length::Space2));
        if !row {
            let children = self.children.into_iter().map(|child| match child {
                Child::Content(content) => column(content, ds).into_any_element(),
                Child::Other(el) => el,
            });
            return strut::flex_scope(true, field.flex_col().children(children)).into_any_element();
        }
        if self.orientation == Orientation::Horizontal && has_content {
            return grid(self.id, field, self.children, window, cx);
        }
        let children = self.children.into_iter().map(|child| match child {
            Child::Content(content) => column(content, ds).into_any_element(),
            Child::Other(el) => el,
        });
        strut::flex_scope(false, field.flex_row().items_center().children(children))
            .into_any_element()
    }
}

/// The two-column row: the content at the start, the controls at the end, row one as tall as the
/// taller of the content's first line and the controls, both centred in it. (CSS grid:
/// `minmax(0, 1fr) auto` with `align-items: center`.) The controls' height is measured by the
/// previous frame.
fn grid(
    id: ElementId,
    field: gpui::Div,
    children: Vec<Child>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let measured: Entity<Pixels> = window.use_keyed_state((id, "controls"), cx, |_, _| px(0.));
    let ds = Ds::get(cx);
    let controls_height = *measured.read(cx);
    let label_line = ds.len(Length::TypoLabelLineHeight);
    let first_row = label_line.max(controls_height);
    let mut left = Vec::new();
    let mut right = Vec::new();
    for child in children {
        match child {
            Child::Content(content) => left.extend(content.children),
            Child::Other(el) => right.push(el),
        }
    }
    let mut left = left.into_iter();
    let first = left.next().map(|first| {
        div()
            .flex()
            .items_center()
            .min_h(first_row)
            .child(strut::flex_scope(true, first))
    });
    let content = FieldContent {
        children: first
            .into_iter()
            .map(IntoElement::into_any_element)
            .chain(left)
            .collect(),
    };
    let measure = {
        let measured = measured.clone();
        canvas(
            |_, _, _| (),
            move |bounds, (), _, cx| {
                if (bounds.size.height - *measured.read(cx)).abs() > px(0.01) {
                    measured.update(cx, |height, cx| {
                        *height = bounds.size.height;
                        cx.notify();
                    });
                }
            },
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full()
    };
    let controls = div()
        .relative()
        .flex()
        .items_center()
        .gap(ds.len(Length::Space2))
        .children(right)
        .child(measure);
    strut::flex_scope(
        false,
        field
            .flex_row()
            .items_start()
            .child(column(content, ds))
            .child(
                div()
                    .flex_none()
                    .flex()
                    .items_center()
                    .h(first_row)
                    .child(controls),
            ),
    )
    .into_any_element()
}
