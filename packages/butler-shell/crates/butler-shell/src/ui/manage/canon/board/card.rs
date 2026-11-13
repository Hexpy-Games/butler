//! `EpicCard.tsx`: an epic as a Kanban card.
use butler_ds::ui::blocks::kanban_board::KanbanCard;
use butler_ds::ui::context::Ds;
use butler_ds::ui::layout::{Cross, MinWidth, Space, Stack, StackItem, WithItem as _};
use butler_ds::ui::tag::Tag;
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{App, IntoElement as _, ParentElement as _, SharedString};

use super::copy::words;
use crate::ui::manage::Pick;
use crate::ui::manage::canon::common::{canon_avatar, criteria_progress, epic_activity, tag_list};
use crate::ui::source::wire::{CanonStatus, EpicCard};

/// What differs between one card and another on the board.
pub(crate) struct Opts {
    pub(crate) show_status: bool,
    pub(crate) ordinal: Option<usize>,
    pub(crate) selected: bool,
    pub(crate) on_select: Option<Pick<SharedString>>,
}

/// What `EpicCard` shows: title, avatar, criteria, tags, counts. The lifted copy shows it too.
fn content(epic: &EpicCard, ordinal: Option<usize>, show_status: bool, cx: &App) -> Stack {
    let words = words(Ds::get(cx).lang());
    let counts = epic.task_counts.as_ref().filter(|counts| counts.total > 0);
    let caption = [
        ordinal.map(|ordinal| words.ordinal(ordinal)),
        counts.map(|counts| {
            let completed = counts.statuses.get("completed").copied().unwrap_or(0);
            words.tasks(completed, counts.total)
        }),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" · ");
    let title = Stack::row()
        .cross(Cross::Center)
        .gap(Space::Sm)
        .children(epic_activity(epic, cx))
        .child(
            Typo::body(epic.title.clone())
                .truncate()
                .shrink(true)
                .min_width(MinWidth::Zero),
        )
        .children(
            canon_avatar(epic.assignee.as_deref(), epic.agent.as_ref(), cx)
                .map(|avatar| StackItem::new().shrink(false).child(avatar)),
        );
    let mut body = Stack::new()
        .gap(Space::Sm)
        .child(title)
        .children(criteria_progress(epic.criteria.as_ref(), None, cx));
    if !epic.tags.is_empty() {
        body = body.child(tag_list(&epic.tags, Some(3), None, cx));
    }
    if !caption.is_empty() {
        body = body.child(Typo::caption(caption).tabular().tone(Tone::Secondary));
    }
    // The lane says the status; only a cancelled epic wears it on the card.
    if show_status {
        body = body.child(super::super::common::status::status_tag(
            SharedString::from(format!("epic-status-{}", epic.id)),
            epic.canon_status,
            words.status(epic.canon_status),
        ));
    } else if epic.canon_status == CanonStatus::Cancelled {
        let status = SharedString::from(format!("epic-status-{}", epic.id));
        body = body.child(Tag::new(status, words.status(CanonStatus::Cancelled)));
    }
    body
}

/// `EpicCard`
pub(crate) fn card(epic: &EpicCard, opts: Opts, cx: &App) -> KanbanCard {
    let (lifted, ordinal, show_status) = (epic.clone(), opts.ordinal, opts.show_status);
    let mut card = KanbanCard::new(epic.id.clone(), epic.title.clone())
        .anchor(format!("kanban-card-{}", epic.id))
        .selected(opts.selected)
        .preview(move |_, cx| content(&lifted, ordinal, show_status, cx).into_any_element())
        .child(content(epic, ordinal, show_status, cx));
    if let Some(on_select) = opts.on_select {
        let id = SharedString::from(epic.id.clone());
        card = card.on_open(move |window, cx| on_select(id.clone(), window, cx));
    }
    card
}
