//! `PlanEpicList.tsx`: the plan's epics as a reorderable card list.
use std::rc::Rc;

use butler_ds::ui::blocks::sortable_card_list::{SortableCardItem, SortableCardList};
use butler_ds::ui::context::Lang;
use butler_ds::ui::layout::{Cross, MinWidth, Space, Stack, StackItem, WithItem as _};
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{App, IntoElement as _, ParentElement as _, SharedString, Window};

use super::actions::{OnAct, epic_actions};
use super::copy::words;
use crate::ui::manage::Pick;
use crate::ui::manage::canon::common::{canon_avatar, criteria_progress, epic_status};
use crate::ui::source::wire::{CanonPlan, EpicCard};

/// What `PlanEpicList` is given besides the rows.
pub(super) struct ListProps {
    /// `backlog` swaps the help line.
    pub(super) backlog: bool,
    /// `busy` locks the cards while a write runs.
    pub(super) busy: bool,
    /// `compact`: the actions move under the description.
    pub(super) compact: bool,
    pub(super) plans: Rc<Vec<CanonPlan>>,
    pub(super) on_reorder: Pick<Vec<SharedString>>,
    pub(super) on_act: OnAct,
    pub(super) lang: Lang,
}

/// `PlanEpicList`
// CARVE-OUT(G-ds): React's list title is a `Tooltip` (`sharedGrip`) and its empty state an
// `EmptyLine` with a Notebook icon; `SortableCardList` takes text for both.
pub(super) fn epic_list(rows: &[&EpicCard], props: ListProps) -> SortableCardList {
    let ListProps {
        backlog,
        busy,
        compact,
        plans,
        on_reorder,
        on_act,
        lang,
    } = props;
    let copy = words(lang);
    let items = rows.iter().enumerate().map(|(index, epic)| {
        let (title_epic, description_epic, actions_epic) =
            ((*epic).clone(), (*epic).clone(), (*epic).clone());
        let (plans, on_act) = (plans.clone(), on_act.clone());
        let actions = move |window: &mut Window, cx: &mut App| {
            epic_actions(&actions_epic, &plans, busy, &on_act, window, cx)
        };
        let mut item = SortableCardItem::new(epic.id.clone(), epic.title.clone())
            .label(epic.title.clone())
            .title_element(move |_, cx| title_row(&title_epic, index + 1, cx));
        item = if compact {
            item.description_element({
                let actions = actions.clone();
                move |window, cx| description(&description_epic, Some(&actions), window, cx)
            })
        } else {
            item.description_element(move |window, cx| {
                description(&description_epic, None, window, cx)
            })
            .actions(actions)
        };
        item
    });
    SortableCardList::new("canon-plan-epics", items.collect())
        .title((copy.epic_count)(rows.len()))
        .description(if backlog {
            copy.backlog_order_help
        } else {
            copy.shared_order
        })
        .empty_message(copy.no_epics)
        .disabled(busy)
        .on_reorder(move |ids, window, cx| on_reorder(ids, window, cx))
}

/// The title: position, status, title and assignee.
fn title_row(epic: &EpicCard, position: usize, cx: &App) -> gpui::AnyElement {
    Stack::row()
        .cross(Cross::Center)
        .gap(Space::Sm)
        .child(
            Typo::caption(format!("{position} ·"))
                .tabular()
                .tone(Tone::Secondary),
        )
        .child(StackItem::new().shrink(false).child(epic_status(epic, cx)))
        .child(
            Typo::body(epic.title.clone())
                .truncate()
                .shrink(true)
                .min_width(MinWidth::Zero),
        )
        .children(
            canon_avatar(epic.assignee.as_deref(), epic.agent.as_ref(), cx)
                .map(|avatar| StackItem::new().shrink(false).child(avatar)),
        )
        .into_any_element()
}

/// A row's action buttons, built where they are shown.
type Actions<'a> = Option<&'a dyn Fn(&mut Window, &mut App) -> gpui::AnyElement>;

/// The first line of the description, the criteria and, on a compact list, the actions.
fn description(
    epic: &EpicCard,
    actions: Actions,
    window: &mut Window,
    cx: &mut App,
) -> gpui::AnyElement {
    let copy = words(butler_ds::ui::context::Ds::get(cx).lang());
    let first = epic.description.lines().next().unwrap_or_default();
    let line = if first.is_empty() {
        copy.no_description
    } else {
        first
    };
    let mut body = Stack::new()
        .gap(Space::Sm)
        .child(
            Typo::caption(line.to_owned())
                .tone(Tone::Secondary)
                .truncate(),
        )
        .children(criteria_progress(epic.criteria.as_ref(), None, cx));
    if let Some(actions) = actions {
        body = body.child(actions(window, cx));
    }
    body.into_any_element()
}
