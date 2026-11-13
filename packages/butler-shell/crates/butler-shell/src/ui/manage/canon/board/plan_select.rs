//! `CanonBoardPlanSelect.tsx`, `useCanonPlanSelection.ts` and `canonPlanSelection.ts`: which plan
//! the board shows, and the picker for it.
use std::collections::HashMap;

use butler_ds::ui::blocks::filtered_select_popover::{FilteredSelectPopover, Group, Item, Width};
use butler_ds::ui::context::Ds;
use butler_ds::ui::popover::{MenuSize, Popover, PopoverContent};
use butler_ds::ui::select_button::{SelectButton, Size};
use butler_ds::ui::tooltip::Align;
use gpui::{
    AnyElement, App, Context, Global, IntoElement as _, ParentElement as _, SharedString,
    WeakEntity, Window, div,
};

use super::CanonBoard;
use super::copy::{Words, words};
use crate::ui::manage::canon::aside::{select_epic, selected_epic};
use crate::ui::source::wire::{CanonOverview, PlanCards};

/// `butler:canon-plan:<project>` in React's `localStorage`; the shell has no such store yet, so
/// the choice lives for this run (it still survives the board being rebuilt).
#[derive(Default)]
struct PlanChoices(HashMap<SharedString, Option<SharedString>>);

impl Global for PlanChoices {}

/// Where the board holds a 과제.
pub(super) enum EpicPlace {
    Backlog,
    Plan(SharedString),
}

/// `canonEpicPlan` (canonPlanSelection.ts): the board plan holding this task, the backlog, or
/// `None` when the board does not have it.
pub(super) fn canon_epic_plan(canon: &CanonOverview, epic: &str) -> Option<EpicPlace> {
    if canon.backlog.iter().any(|card| card.id == epic) {
        return Some(EpicPlace::Backlog);
    }
    canon
        .plans
        .iter()
        .find(|plan| plan.works.iter().any(|card| card.id == epic))
        .map(|plan| EpicPlace::Plan(SharedString::from(plan.plan.id.clone())))
}

/// `selection.select` in Electron's `CanonBoard.tsx`, preserving task selection.
pub(super) fn store_plan_choice(project: &SharedString, plan: Option<SharedString>, cx: &mut App) {
    cx.default_global::<PlanChoices>()
        .0
        .insert(project.clone(), plan);
}

/// The picker's own state (`open`, `search`).
#[derive(Default)]
pub(super) struct Picker {
    open: bool,
    query: SharedString,
}

/// `defaultCanonPlan`: the open plan due soonest, else the open plan touched last.
fn default_plan(plans: &[PlanCards]) -> Option<SharedString> {
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let open = || plans.iter().filter(|plan| plan.plan.status == "open");
    let newest_first = |a: &&PlanCards, b: &&PlanCards| {
        b.plan
            .updated_at
            .unwrap_or(0)
            .cmp(&a.plan.updated_at.unwrap_or(0))
    };
    let future = open()
        .filter(|plan| {
            plan.plan
                .due_on
                .as_deref()
                .is_some_and(|due| due >= today.as_str())
        })
        .min_by(|a, b| {
            a.plan
                .due_on
                .cmp(&b.plan.due_on)
                .then_with(|| newest_first(a, b))
        });
    let chosen = future.or_else(|| open().min_by(newest_first));
    chosen.map(|plan| SharedString::from(plan.plan.id.clone()))
}

/// One item per plan matching the search, then the backlog.
fn plan_items(
    plans: &[PlanCards],
    value: Option<&SharedString>,
    query: &str,
    words: &Words,
    board: &WeakEntity<CanonBoard>,
) -> Vec<Item> {
    let query = query.to_lowercase();
    let options = plans
        .iter()
        .map(|plan| (Some(plan.plan.id.as_str()), plan.plan.title.as_str()))
        .chain([(None, words.backlog)])
        .filter(|(_, label)| label.to_lowercase().contains(&query));
    options
        .map(|(id, label)| {
            let board = board.clone();
            let id = id.map(SharedString::from);
            Item::new(
                id.clone().unwrap_or_else(|| "backlog".into()),
                label.to_owned(),
            )
            .selected(id.as_ref() == value)
            .on_select(move |_, cx| {
                let id = id.clone();
                let _ = board.update(cx, |this, cx| this.choose_plan(id, cx));
            })
        })
        .collect()
}

impl CanonBoard {
    /// `useCanonPlanSelection`: the stored choice when it still names a plan, else the default.
    pub(super) fn plan_id(&self, plans: Option<&[PlanCards]>, cx: &App) -> Option<SharedString> {
        let stored = cx
            .try_global::<PlanChoices>()
            .and_then(|choices| choices.0.get(&self.project).cloned());
        match stored {
            Some(None) => None,
            Some(Some(id))
                if plans.is_some_and(|plans| plans.iter().any(|plan| plan.plan.id == *id)) =>
            {
                Some(id)
            }
            _ => plans.and_then(default_plan),
        }
    }

    /// `selection.select(id); selectionDetail.select(null)`
    pub(super) fn choose_plan(&mut self, id: Option<SharedString>, cx: &mut Context<Self>) {
        store_plan_choice(&self.project, id, cx);
        self.picker.open = false;
        self.picker.query = SharedString::default();
        if selected_epic(&self.ctx, &self.project, cx).is_some() {
            select_epic(&self.ctx, self.project.clone(), None, cx);
        }
        cx.notify();
    }

    /// The picker's popover: its open state follows `picker`, and closing clears the search.
    fn plan_popover(
        &self,
        board: &WeakEntity<Self>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Popover {
        let board = board.clone();
        Popover::new("canon-plan-picker", window, cx)
            .open(self.picker.open)
            .on_open_change(move |open, _, cx| {
                let _ = board.update(cx, |this, cx| {
                    this.picker.open = open;
                    if !open {
                        this.picker.query = SharedString::default();
                    }
                    cx.notify();
                });
            })
    }

    /// `CanonBoardPlanSelect`
    pub(super) fn plan_select(
        &self,
        plans: &[PlanCards],
        value: Option<&SharedString>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let words = words(Ds::get(cx).lang());
        let board = cx.entity().downgrade();
        let popover = self.plan_popover(&board, window, cx);
        let title = plans
            .iter()
            .find(|plan| value.map(|value| &**value) == Some(plan.plan.id.as_str()))
            .map_or(words.backlog, |plan| plan.plan.title.as_str());
        let trigger = popover.trigger_fill(|toggle| {
            SelectButton::new("canon-plan-trigger")
                .size(Size::Sm)
                .text(title.to_owned())
                .on_click(toggle.on_click())
                .into_any_element()
        });
        let items = plan_items(plans, value, &self.picker.query, words, &board);
        let search_board = board;
        let body = FilteredSelectPopover::new(
            "canon-plan-chooser",
            words.plan,
            words.search_plan,
            words.no_results,
        )
        .search(self.picker.query.clone(), move |text, _, cx| {
            let text = SharedString::from(text.to_owned());
            let _ = search_board.update(cx, |this, cx| {
                this.picker.query = text;
                cx.notify();
            });
        })
        .groups(vec![Group::new("plans", "", items)])
        .width(Width::Fixed);
        // CARVE-OUT(G-ds): React keeps the popover clear of the composer footer with
        // `collisionPadding.bottom = bottomInset + 8`; `PopoverContent` has no collision padding.
        let content = popover.content(
            PopoverContent::new()
                .align(Align::Start)
                .menu_size(MenuSize::Fit)
                .child(body),
            window,
            cx,
        );
        div().child(trigger).child(content).into_any_element()
    }
}
