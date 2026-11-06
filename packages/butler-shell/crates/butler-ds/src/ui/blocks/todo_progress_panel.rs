//! DS TodoProgressPanel (TodoProgressPanel.tsx, TodoProgressItemRow.tsx and their CSS): the plan's
//! steps in a composer adjunct. Each step has a state icon, its title and a status label; while
//! collapsed the header summarises the step that is running, under review, needing correction or
//! blocked.
use gpui::{
    AnyElement, App, ElementId, IntoElement, ParentElement, RenderOnce, SharedString, Styled as _,
    Window, div,
};

use super::composer_adjunct_panel::ComposerAdjunctPanel;
use crate::tokens::{Color, Length};
use crate::ui::Icon;
use crate::ui::context::Ds;
use crate::ui::icon::icon_px;
use crate::ui::layout::{Cross, Space, Stack};
use crate::ui::spinner::Spinner;
use crate::ui::strut;
use crate::ui::success_check::SuccessCheck;
use crate::ui::typo::{Tone, Typo, Wrap};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TodoState {
    Pending,
    Running,
    Reviewing,
    Completed,
    CorrectionRequired,
    Blocked,
    Skipped,
    Stopped,
}

pub struct TodoItem {
    pub id: SharedString,
    pub title: SharedString,
    pub state: TodoState,
    pub status_label: SharedString,
}

impl TodoItem {
    pub fn new(
        id: impl Into<SharedString>,
        title: impl Into<SharedString>,
        state: TodoState,
        status_label: impl Into<SharedString>,
    ) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            state,
            status_label: status_label.into(),
        }
    }
}

#[derive(IntoElement)]
pub struct TodoProgressPanel {
    id: ElementId,
    heading: SharedString,
    items: Vec<TodoItem>,
}

impl TodoProgressPanel {
    pub fn new(id: impl Into<ElementId>, heading: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            heading: heading.into(),
            items: Vec::new(),
        }
    }

    pub fn items(mut self, items: Vec<TodoItem>) -> Self {
        self.items = items;
        self
    }
}

/// The state icon: running and completed share one slot, so running to completed draws the check
/// (`LoadingIndicator`: the check animates only when it saw the spinner first).
fn marker(id: &SharedString, state: TodoState, window: &mut Window, cx: &mut App) -> AnyElement {
    let side = f32::from(Ds::get(cx).len(Length::IconSizeMd));
    let loading = matches!(state, TodoState::Running | TodoState::Reviewing);
    let saw = window.use_keyed_state(format!("{id}-saw-loading"), cx, move |_, _| loading);
    if loading && !*saw.read(cx) {
        saw.update(cx, |saw, _| *saw = true);
    }
    let animate = *saw.read(cx);
    let ds = Ds::get(cx);
    let glyph = |icon| icon_px(icon, ds.len(Length::IconSizeMd)).into_any_element();
    match state {
        TodoState::Completed => SuccessCheck::new(format!("{id}-check"))
            .ring()
            .size(side)
            .animate_if(animate)
            .into_any_element(),
        TodoState::Blocked => glyph(Icon::AlertCircle),
        TodoState::Skipped => glyph(Icon::Minus),
        TodoState::CorrectionRequired | TodoState::Stopped => glyph(Icon::CircleX),
        TodoState::Running | TodoState::Reviewing => Spinner::new(format!("{id}-spinner"))
            .size(side)
            .into_any_element(),
        TodoState::Pending => glyph(Icon::Circle),
    }
}

fn row(item: &TodoItem, window: &mut Window, cx: &mut App) -> AnyElement {
    let icon = marker(&item.id, item.state, window, cx);
    let ds = Ds::get(cx);
    let marker_ink = match item.state {
        TodoState::Running | TodoState::Reviewing => Color::Accent,
        TodoState::Completed => Color::Ok,
        TodoState::Blocked => Color::Danger,
        _ => Color::TextTertiary,
    };
    let quiet = matches!(
        item.state,
        TodoState::CorrectionRequired | TodoState::Skipped | TodoState::Stopped
    );
    div()
        .flex()
        .items_center()
        .min_w_0()
        .gap(ds.len(Length::Space2))
        .text_color(ds.color(if quiet {
            Color::TextTertiary
        } else {
            Color::TextSecondary
        }))
        .child(
            div()
                .flex()
                .flex_none()
                .items_center()
                .justify_center()
                .size(ds.len(Length::TypoBodyLineHeight))
                .text_color(ds.color(marker_ink))
                .child(icon),
        )
        .child(
            div().flex_1().min_w_0().child(
                Typo::body(item.title.clone())
                    .truncate()
                    .tone(Tone::Inherit),
            ),
        )
        .child(
            div().flex_none().child(strut::flex_scope(
                false,
                Typo::caption(item.status_label.clone())
                    .tone(Tone::Tertiary)
                    .wrap(Wrap::Nowrap),
            )),
        )
        .into_any_element()
}

impl RenderOnce for TodoProgressPanel {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        if self.items.is_empty() {
            return div().into_any_element();
        }
        let current = self.items.iter().find(|item| {
            matches!(
                item.state,
                TodoState::Running
                    | TodoState::Reviewing
                    | TodoState::CorrectionRequired
                    | TodoState::Blocked
            )
        });
        let summary = current.map(|item| format!("{}: {}", item.status_label, item.title));
        let icon = icon_px(Icon::ListChecks, Ds::get(cx).len(Length::IconSizeMd));
        let rows: Vec<AnyElement> = self
            .items
            .iter()
            .map(|item| row(item, window, cx))
            .collect();
        let mut panel = ComposerAdjunctPanel::new(self.id)
            .heading(self.heading)
            .icon(icon);
        if let Some(summary) = summary {
            panel = panel.collapsed_summary(summary);
        }
        let list = Stack::new()
            .gap(Space::Xs)
            .cross(Cross::Stretch)
            .children(rows);
        panel.child(list).into_any_element()
    }
}
