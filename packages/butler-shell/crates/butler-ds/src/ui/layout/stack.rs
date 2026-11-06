//! DS Stack and Inline (Stack.tsx / Stack.module.css): a flex container with token gaps.
use gpui::{
    AnyElement, App, Div, IntoElement, ParentElement, RenderOnce, Styled as _, Window,
    WindowControlArea, div, prelude::*,
};

use super::{ItemProps, Space, WithItem};
use crate::ui::context::Ds;
use crate::ui::strut;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Align {
    Row,
    #[default]
    Column,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Justify {
    #[default]
    Start,
    Center,
    End,
    Between,
    Around,
    Evenly,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Cross {
    Start,
    Center,
    End,
    #[default]
    Stretch,
    Baseline,
}

/// Electron's `app-region`: a window drag area.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum WindowDrag {
    #[default]
    Inherit,
    Drag,
    NoDrag,
}

#[derive(IntoElement)]
pub struct Stack {
    align: Align,
    gap: Space,
    row_gap: Option<Space>,
    compact_gap: Option<Space>,
    justify: Justify,
    cross: Cross,
    fill: bool,
    wrap: bool,
    drag: WindowDrag,
    item: ItemProps,
    children: Vec<AnyElement>,
}

impl Stack {
    pub fn new() -> Self {
        Self {
            align: Align::Column,
            gap: Space::Md,
            row_gap: None,
            compact_gap: None,
            justify: Justify::Start,
            cross: Cross::Stretch,
            fill: false,
            wrap: false,
            drag: WindowDrag::Inherit,
            item: ItemProps::default(),
            children: Vec::new(),
        }
    }

    pub fn row() -> Self {
        Self::new().align(Align::Row)
    }

    pub fn align(mut self, align: Align) -> Self {
        self.align = align;
        self
    }

    pub fn gap(mut self, gap: Space) -> Self {
        self.gap = gap;
        self
    }

    pub fn row_gap(mut self, gap: Space) -> Self {
        self.row_gap = Some(gap);
        self
    }

    /// The gap on mobile (the compact ramp).
    pub fn compact_gap(mut self, gap: Space) -> Self {
        self.compact_gap = Some(gap);
        self
    }

    pub fn justify(mut self, justify: Justify) -> Self {
        self.justify = justify;
        self
    }

    pub fn cross(mut self, cross: Cross) -> Self {
        self.cross = cross;
        self
    }

    /// `flex: 1 1 auto; min-height: 0`.
    pub fn fill(mut self) -> Self {
        self.fill = true;
        self
    }

    pub fn wrap(mut self, wrap: bool) -> Self {
        self.wrap = wrap;
        self
    }

    pub fn window_drag(mut self, drag: WindowDrag) -> Self {
        self.drag = drag;
        self
    }
}

impl Default for Stack {
    fn default() -> Self {
        Self::new()
    }
}

impl WithItem for Stack {
    fn item_mut(&mut self) -> &mut ItemProps {
        &mut self.item
    }
}

impl ParentElement for Stack {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

fn justify(el: Div, justify: Justify) -> Div {
    match justify {
        Justify::Start => el.justify_start(),
        Justify::Center => el.justify_center(),
        Justify::End => el.justify_end(),
        Justify::Between => el.justify_between(),
        Justify::Around => el.justify_around(),
        Justify::Evenly => el.justify_evenly(),
    }
}

fn cross(el: Div, cross: Cross) -> Div {
    match cross {
        Cross::Start => el.items_start(),
        Cross::Center => el.items_center(),
        Cross::End => el.items_end(),
        Cross::Stretch => el.items_stretch(),
        Cross::Baseline => el.items_baseline(),
    }
}

impl RenderOnce for Stack {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let gap = match (ds.compact(), self.compact_gap) {
            (true, Some(compact)) => compact,
            _ => self.gap,
        };
        let mut el = div().flex().min_w_0().gap(gap.px(ds));
        if let Some(row_gap) = self.row_gap {
            el = el.gap_y(row_gap.px(ds));
        }
        el = match self.align {
            Align::Row => el.flex_row(),
            Align::Column => el.flex_col(),
        };
        el = cross(justify(el, self.justify), self.cross);
        if self.wrap {
            el = el.flex_wrap();
        }
        if self.fill {
            el = el.flex_grow(1.).flex_shrink(1.).min_h_0();
        }
        if self.drag == WindowDrag::Drag {
            el = el.window_control_area(WindowControlArea::Drag);
        }
        let stretch_column = self.align == Align::Column && self.cross == Cross::Stretch;
        strut::flex_scope(
            stretch_column,
            self.item.apply(el, ds).children(self.children),
        )
    }
}

/// A Stack child that carries only item props.
#[derive(IntoElement)]
pub struct StackItem {
    item: ItemProps,
    children: Vec<AnyElement>,
}

impl StackItem {
    pub fn new() -> Self {
        Self {
            item: ItemProps::default(),
            children: Vec::new(),
        }
    }
}

impl Default for StackItem {
    fn default() -> Self {
        Self::new()
    }
}

impl WithItem for StackItem {
    fn item_mut(&mut self) -> &mut ItemProps {
        &mut self.item
    }
}

impl ParentElement for StackItem {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for StackItem {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        strut::scope(
            true,
            strut::container(self.item.apply(div(), Ds::get(cx)), Ds::get(cx))
                .children(self.children),
        )
    }
}

/// A Stack with `align="row"`, `cross="center"`, `gap="sm"` and `wrap`.
pub struct Inline;

impl Inline {
    #[allow(
        clippy::new_ret_no_self,
        reason = "Inline is a Stack preset, as in React"
    )]
    pub fn new() -> Stack {
        Stack::row().cross(Cross::Center).gap(Space::Sm).wrap(true)
    }
}
