//! DS TaskGraphSection and TaskGraphPanel (TaskGraphSection.tsx). [`TaskGraphPanel`] is the Tasks
//! tab body: an inset Section header with a summary, the empty state, and the graph sections
//! `xs` apart. [`TaskGraphSection`] is one plan graph: a DisclosureRow on its default selection
//! surface, rendered without children (the graph sits below the row, so cards keep the inspector
//! inset instead of the row panel's title-column indent), and the graph below.
use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, IntoElement, ParentElement, RenderOnce, SharedString, Styled as _,
    Window, div,
};

use super::disclosure_row::DisclosureRow;
use super::empty_line::EmptyLine;
use super::inspector_panel::InspectorInset;
use super::task_graph_card::{TaskGraphStatus, TaskGraphStatusIcon};
use crate::tokens::Color;
use crate::ui::context::Ds;
use crate::ui::layout::{Cross, Justify, MinWidth, Space, Stack, WithItem as _};
use crate::ui::typo::{Tone, Typo};

type Toggle = Rc<dyn Fn(&mut Window, &mut App)>;

/// One graph in the Tasks tab. Children are the graph (TaskGraphCanvas) and, when it owns the
/// selection, TaskGraphDetail.
#[derive(IntoElement)]
pub struct TaskGraphSection {
    graph_id: SharedString,
    title: SharedString,
    status: TaskGraphStatus,
    meta: Option<SharedString>,
    open: bool,
    collapsible: bool,
    on_toggle: Option<Toggle>,
    children: Vec<AnyElement>,
}

impl TaskGraphSection {
    /// `graph_id` keys the row and its status glyph; `title` is the plan's goal; `status` is the
    /// rolled-up state of the graph (`rollup_status`).
    pub fn new(
        graph_id: impl Into<SharedString>,
        title: impl Into<SharedString>,
        status: TaskGraphStatus,
    ) -> Self {
        Self {
            graph_id: graph_id.into(),
            title: title.into(),
            status,
            meta: None,
            open: false,
            collapsible: true,
            on_toggle: None,
            children: Vec::new(),
        }
    }

    /// Counts, e.g. "7/16 done · 1 failed".
    pub fn meta(mut self, meta: impl Into<SharedString>) -> Self {
        self.meta = Some(meta.into());
        self
    }

    pub fn open(mut self, open: bool) -> Self {
        self.open = open;
        self
    }

    /// False for the only graph: no row, the content is always shown.
    pub fn collapsible(mut self, collapsible: bool) -> Self {
        self.collapsible = collapsible;
        self
    }

    pub fn on_toggle(mut self, handler: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_toggle = Some(Rc::new(handler));
        self
    }
}

impl ParentElement for TaskGraphSection {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for TaskGraphSection {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let open = !self.collapsible || self.open;
        let id = self.graph_id;
        let row = self.collapsible.then(|| {
            let mut row = DisclosureRow::new(
                SharedString::from(format!("task-graph-row-{id}")),
                self.title,
            )
            .icon(TaskGraphStatusIcon::new(
                format!("task-graph-{id}-status"),
                self.status,
            ))
            .open(open)
            .reveals();
            if let Some(meta) = self.meta {
                row = row.meta(meta);
            }
            if let Some(toggle) = self.on_toggle {
                row = row.on_toggle(move |_: &ClickEvent, window, cx| toggle(window, cx));
            }
            InspectorInset::new().child(row)
        });
        let ds = Ds::get(cx);
        let inset = if self.collapsible {
            Space::Sm.px(ds)
        } else {
            Space::None.px(ds)
        };
        let graph = open.then(|| {
            div()
                .py(inset)
                .child(Stack::new().gap(Space::Md).children(self.children))
        });
        Stack::new().gap(Space::None).children(row).children(graph)
    }
}

/// The Tasks tab body. The header-to-content space is the Section's own gap (`lg`); folded
/// sections sit `xs` apart (the DS row rhythm).
#[derive(IntoElement)]
pub struct TaskGraphPanel {
    title: SharedString,
    icon: Option<AnyElement>,
    description: Option<SharedString>,
    header_meta: Option<SharedString>,
    empty_label: SharedString,
    empty: bool,
    children: Vec<AnyElement>,
}

impl TaskGraphPanel {
    /// `empty_label` shows while `empty(true)`.
    pub fn new(title: impl Into<SharedString>, empty_label: impl Into<SharedString>) -> Self {
        Self {
            title: title.into(),
            icon: None,
            description: None,
            header_meta: None,
            empty_label: empty_label.into(),
            empty: false,
            children: Vec::new(),
        }
    }

    pub fn icon(mut self, icon: impl IntoElement) -> Self {
        self.icon = Some(icon.into_any_element());
        self
    }

    /// With one graph: its goal, shown under the title.
    pub fn description(mut self, description: impl Into<SharedString>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// Right of the title: one graph's counts, or "6 graphs · 2 running".
    pub fn header_meta(mut self, meta: impl Into<SharedString>) -> Self {
        self.header_meta = Some(meta.into());
        self
    }

    /// No graphs: the empty line replaces the sections.
    pub fn empty(mut self, empty: bool) -> Self {
        self.empty = empty;
        self
    }
}

impl ParentElement for TaskGraphPanel {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

/// Section's header (Section.tsx): icon and title on one row with the meta at the end, the
/// description under it.
fn header(panel: &mut TaskGraphPanel, cx: &App) -> AnyElement {
    let secondary = Ds::get(cx).color(Color::TextSecondary);
    let title = Stack::row()
        .cross(Cross::Center)
        .gap(Space::Sm)
        .min_width(MinWidth::Zero)
        .children(panel.icon.take().map(|icon| {
            div()
                .flex()
                .flex_none()
                .text_color(secondary) // DS: Section.module.css:20
                .child(icon)
        }))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .child(Typo::panel_section_title(panel.title.clone()).tone(Tone::Primary)),
        );
    let row = Stack::row()
        .justify(Justify::Between)
        .cross(Cross::Center)
        .gap(Space::Md)
        .min_width(MinWidth::Zero)
        .child(title)
        .children(panel.header_meta.take().map(|meta| {
            Stack::row()
                .cross(Cross::Center)
                .gap(Space::Sm)
                .shrink(false)
                .child(Typo::caption(meta).tone(Tone::Tertiary).tabular())
        }));
    Stack::new()
        .gap(Space::Sm)
        .min_width(MinWidth::Zero)
        .child(row)
        .children(
            panel
                .description
                .take()
                .map(|text| Typo::body(text).tone(Tone::Secondary)),
        )
        .into_any_element()
}

impl RenderOnce for TaskGraphPanel {
    fn render(mut self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let header = header(&mut self, cx);
        let section = Stack::new()
            .gap(Space::Lg)
            .min_width(MinWidth::Zero)
            .child(header)
            .child(
                Stack::new()
                    .gap(Space::Sm)
                    .min_width(MinWidth::Zero)
                    .children(self.empty.then(|| EmptyLine::new(self.empty_label.clone()))),
            );
        let sections = (!self.empty).then(|| Stack::new().gap(Space::Xs).children(self.children));
        Stack::new()
            .gap(Space::None)
            .child(InspectorInset::new().child(section))
            .children(sections)
    }
}
