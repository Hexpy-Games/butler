//! DS TaskGraphDetail (TaskGraphDetail.tsx): the selected task, read-only. Its status, facts,
//! prerequisite links, the task document and the conversation action. Data-agnostic: all copy
//! and actions come in through the builder.
pub mod document_tile;

use std::rc::Rc;

use gpui::{
    AnyElement, App, ElementId, IntoElement, ParentElement as _, RenderOnce, SharedString,
    Styled as _, Window, div, px,
};

use self::document_tile::{ClickTarget, DocumentTile};
use super::inspector_panel::InspectorPanel;
use super::key_value_row::{KeyValueRow, ValueSize};
use super::notice::{Notice, NoticeTone};
use super::task_graph_card::{TaskGraphStatus, status_tone};
use crate::ui::Icon;
use crate::ui::button::{self, Button, Size as ButtonSize, Variant as ButtonVariant};
use crate::ui::clickable::{Clickable, Variant as ClickableVariant};
use crate::ui::context::Ds;
use crate::ui::icon::{IconSize, icon};
use crate::ui::layout::{Cross, Space, Stack};
use crate::ui::tag::{Size as TagSize, Tag};
use crate::ui::typo::{Tone, Typo};

/// Called with a task id when a prerequisite link is chosen.
pub type SelectHandler = Rc<dyn Fn(&SharedString, &mut Window, &mut App)>;
type OpenHandler = Rc<dyn Fn(&mut Window, &mut App)>;

/// A fact's value: plain text, or an element such as a `TaskGraphStepLine`.
pub enum FactValue {
    Text(SharedString),
    Element(AnyElement),
}

/// One labelled fact row (assignee, model, elapsed time, current step).
pub struct TaskGraphDetailFact {
    pub id: SharedString,
    pub label: SharedString,
    pub value: FactValue,
}

impl TaskGraphDetailFact {
    pub fn text(
        id: impl Into<SharedString>,
        label: impl Into<SharedString>,
        value: impl Into<SharedString>,
    ) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            value: FactValue::Text(value.into()),
        }
    }

    pub fn element(
        id: impl Into<SharedString>,
        label: impl Into<SharedString>,
        value: impl IntoElement,
    ) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            value: FactValue::Element(value.into_any_element()),
        }
    }
}

/// A linked task in a relation row.
pub struct RelatedTask {
    pub id: SharedString,
    pub title: SharedString,
}

/// A row of prerequisite links ("After" / "Next").
pub struct TaskGraphDetailRelation {
    pub id: SharedString,
    pub label: SharedString,
    pub tasks: Vec<RelatedTask>,
    /// Shown when `tasks` is empty ("None").
    pub empty_label: SharedString,
}

/// Failure reason (error) or blocked explanation (warning); short, no codes.
pub struct DetailNotice {
    pub tone: NoticeTone,
    pub message: SharedString,
}

/// The task document tile; opening it shows the caller's document dialog.
pub struct DetailDocument {
    pub title: SharedString,
    pub meta: Option<SharedString>,
    pub action_label: Option<SharedString>,
    pub on_open: OpenHandler,
}

/// Opens the worker's conversation (the caller's session dialog).
pub struct DetailConversation {
    pub label: SharedString,
    pub on_open: OpenHandler,
}

#[derive(IntoElement)]
pub struct TaskGraphDetail {
    id: ElementId,
    title: SharedString,
    status: TaskGraphStatus,
    status_label: SharedString,
    notice: Option<DetailNotice>,
    facts: Vec<TaskGraphDetailFact>,
    relations: Vec<TaskGraphDetailRelation>,
    on_select_task: Option<SelectHandler>,
    document: Option<DetailDocument>,
    conversation: Option<DetailConversation>,
}

impl TaskGraphDetail {
    /// `id` keys the detail's tag, links and buttons.
    pub fn new(
        id: impl Into<ElementId>,
        title: impl Into<SharedString>,
        status: TaskGraphStatus,
        status_label: impl Into<SharedString>,
    ) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            status,
            status_label: status_label.into(),
            notice: None,
            facts: Vec::new(),
            relations: Vec::new(),
            on_select_task: None,
            document: None,
            conversation: None,
        }
    }

    pub fn notice(mut self, tone: NoticeTone, message: impl Into<SharedString>) -> Self {
        self.notice = Some(DetailNotice {
            tone,
            message: message.into(),
        });
        self
    }

    /// Assignee, model, elapsed time, current step... in order.
    pub fn facts(mut self, facts: Vec<TaskGraphDetailFact>) -> Self {
        self.facts = facts;
        self
    }

    /// Prerequisite links; choosing one only moves the selection (`on_select_task`).
    pub fn relations(mut self, relations: Vec<TaskGraphDetailRelation>) -> Self {
        self.relations = relations;
        self
    }

    pub fn on_select_task(
        mut self,
        handler: impl Fn(&SharedString, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_select_task = Some(Rc::new(handler));
        self
    }

    pub fn document(mut self, document: DetailDocument) -> Self {
        self.document = Some(document);
        self
    }

    pub fn conversation(mut self, conversation: DetailConversation) -> Self {
        self.conversation = Some(conversation);
        self
    }
}

fn fact_row(fact: TaskGraphDetailFact) -> AnyElement {
    match fact.value {
        FactValue::Text(text) => KeyValueRow::new(fact.label, text)
            .value_size(ValueSize::Caption)
            .into_any_element(),
        FactValue::Element(element) => KeyValueRow::new(fact.label, "")
            .value_element(element)
            .value_size(ValueSize::Caption)
            .into_any_element(),
    }
}

fn relation_row(
    id: &ElementId,
    relation: TaskGraphDetailRelation,
    on_select: Option<&SelectHandler>,
) -> AnyElement {
    let value = if relation.tasks.is_empty() {
        Typo::caption(relation.empty_label)
            .tone(Tone::Tertiary)
            .into_any_element()
    } else {
        let links = relation.tasks.into_iter().map(|task| {
            let select = on_select.cloned();
            let target = task.id.clone();
            Clickable::new((id.clone(), format!("{}-{}", relation.id, task.id)))
                .variant(ClickableVariant::Text)
                .on_click(move |_, window, cx| {
                    if let Some(select) = &select {
                        select(&target, window, cx);
                    }
                })
                .child(Typo::caption(task.title).tone(Tone::Secondary))
        });
        Stack::new()
            .gap(Space::Xs)
            .cross(Cross::End)
            .children(links)
            .into_any_element()
    };
    KeyValueRow::new(relation.label, "")
        .value_element(value)
        .value_size(ValueSize::Caption)
        .into_any_element()
}

impl RenderOnce for TaskGraphDetail {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let id = self.id;
        let tag = Tag::new((id.clone(), "status"), self.status_label)
            .size(TagSize::Sm)
            .tone(status_tone(self.status));
        let mut panel = InspectorPanel::new(self.title).action(tag);
        if let Some(notice) = self.notice {
            let glyph = icon(Icon::AlertCircle, IconSize::Md, ds);
            panel = panel.child(Notice::new(notice.tone, notice.message).icon(glyph));
        }
        let rows = self.facts.into_iter().map(fact_row).chain(
            self.relations
                .into_iter()
                .map(|relation| relation_row(&id, relation, self.on_select_task.as_ref())),
        );
        panel = panel.child(Stack::new().gap(Space::Xs).children(rows));
        if let Some(document) = self.document {
            let mut tile = DocumentTile::new((id.clone(), "document"), document.title)
                .icon(icon(Icon::FileText, IconSize::Md, ds))
                .click_target(ClickTarget::Tile)
                .on_open(move |_, window, cx| (document.on_open)(window, cx));
            if let Some(meta) = document.meta {
                tile = tile.meta(meta);
            }
            if let Some(label) = document.action_label {
                tile = tile.action_label(label);
            }
            panel = panel.child(tile);
        }
        if let Some(conversation) = self.conversation {
            let open = conversation.on_open;
            panel = panel.child(
                button::container(ButtonSize::Sm).child(
                    Button::new((id.clone(), "conversation"))
                        .variant(ButtonVariant::Outline)
                        .size(ButtonSize::Sm)
                        .icon_start(icon(Icon::MessageSquare, IconSize::Sm, ds))
                        .text(conversation.label)
                        .on_click(move |_, window, cx| open(window, cx)),
                ),
            );
        }
        div().min_w(px(0.)).child(panel)
    }
}
