//! `CanonPlanLanes.tsx` and the backlog lane of `CanonBoard.tsx`.
use butler_ds::tokens::Length;
use butler_ds::ui::blocks::kanban_board::{KanbanBoard, KanbanLane, LaneHeight, LaneLayout};
use butler_ds::ui::button::{self, Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::icon_button::IconButton;
use butler_ds::ui::layout::{Cross, Space, Stack};
use butler_ds::ui::scroll::{Axis, Config, fade, read};
use butler_ds::ui::section::Section;
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{
    AnyElement, App, ElementId, IntoElement as _, ParentElement as _, ScrollHandle, SharedString,
    Window, point,
};

use super::card::{Opts, card};
use super::copy::{Words, words};
use super::lanes::{CANON_LANES, canon_lane_id, lane_status};
use crate::ui::Icon;
use crate::ui::manage::Pick;
use crate::ui::source::wire::{CanonOverview, CanonPlan, CanonStatus, EpicCard, PlanCards};

/// What the board hands every lane.
pub(super) struct Lanes<'a> {
    /// `matches`: the tags the board is filtered by (none: every epic).
    pub(super) filter: &'a [SharedString],
    pub(super) selected: Option<&'a str>,
    pub(super) on_select: Pick<SharedString>,
    /// `setCreate({ planId })`
    pub(super) on_create: Pick<Option<SharedString>>,
    /// The plan's edit button opens `PlanFormDialog`.
    pub(super) on_edit: Pick<CanonPlan>,
}

impl Lanes<'_> {
    fn shows(&self, epic: &EpicCard) -> bool {
        self.filter.is_empty()
            || epic
                .tags
                .iter()
                .any(|tag| self.filter.iter().any(|id| *id == tag.id))
    }

    fn card(&self, epic: &EpicCard, ordinal: Option<usize>, cx: &App) -> AnyElement {
        let opts = Opts {
            ordinal,
            selected: self.selected == Some(epic.id.as_str()),
            on_select: Some(self.on_select.clone()),
        };
        card(epic, opts, cx).into_any_element()
    }

    /// The "New Epic" button at the foot of a lane.
    fn new_epic(&self, id: String, plan: Option<SharedString>, cx: &App) -> AnyElement {
        let on_create = self.on_create.clone();
        Button::new(SharedString::from(id))
            .variant(Variant::Borderless)
            .size(Size::Xs)
            .icon_start(icon(Icon::Plus, IconSize::Xs, Ds::get(cx)))
            .text(words(Ds::get(cx).lang()).new_epic)
            .on_click(move |_, window, cx| on_create(plan.clone(), window, cx))
            .into_any_element()
    }
}

/// The backlog lane (`CanonBoard.tsx` `data-canon-backlog`).
pub(super) fn backlog_lane(canon: &CanonOverview, lanes: &Lanes, cx: &App) -> AnyElement {
    let words = words(Ds::get(cx).lang());
    // CARVE-OUT(G-ds): `KanbanLane` takes a text title; React's is the title with a caption.
    let title = format!(
        "{} · {}",
        words.backlog,
        words.backlog_count(canon.backlog.len())
    );
    let mut lane = KanbanLane::new("canon-backlog", title)
        .lane_id("backlog")
        .label(words.backlog)
        .height(LaneHeight::Content)
        .layout(LaneLayout::Grid);
    for epic in canon.backlog.iter().filter(|epic| lanes.shows(epic)) {
        lane = lane.child(lanes.card(epic, None, cx));
    }
    if canon.backlog.is_empty() && canon.plans.is_empty() {
        lane = lane.child(Typo::caption(words.backlog_description).tone(Tone::Secondary));
    }
    lane.child(lanes.new_epic("canon-new-epic-backlog".into(), None, cx))
        .into_any_element()
}

/// `CanonPlanLanes`: the plan's title and progress above its five status lanes.
pub(super) fn plan_lanes(
    plan: &PlanCards,
    caption: String,
    lanes: &Lanes,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let words = words(Ds::get(cx).lang());
    let title = Stack::row()
        .cross(Cross::Baseline)
        .gap(Space::Sm)
        .wrap(true)
        .child(Typo::h3(plan.plan.title.clone()))
        .child(Typo::caption(caption).tone(Tone::Secondary));
    let board_id = SharedString::from(format!("canon-plan-lanes-{}", plan.plan.id));
    let handle = lanes_handle(&board_id, window, cx);
    let (on_edit, edited) = (lanes.on_edit.clone(), plan.plan.clone());
    let edit = IconButton::new(
        SharedString::from(format!("canon-plan-edit-{}", plan.plan.id)),
        words.edit,
    )
    .glyph(Icon::Pencil)
    .on_click(move |_, window, cx| on_edit(edited.clone(), window, cx));
    let mut actions = button::container(Size::Sm);
    // `edges.overflow`: the arrows show only while the lanes overflow the board.
    let edges = read(&handle, Axis::X);
    if edges.overflowing {
        actions = actions
            .child(lanes_arrow(&board_id, &handle, -1., edges.at_start, words))
            .child(lanes_arrow(&board_id, &handle, 1., edges.at_end, words));
    }
    let actions = actions.child(edit);
    let mut board = KanbanBoard::new(board_id).scroll(true);
    for status in CANON_LANES {
        let lane_id = canon_lane_id(Some(&plan.plan.id), status);
        let cards: Vec<(usize, &EpicCard)> = plan
            .works
            .iter()
            .enumerate()
            .filter(|(_, epic)| lanes.shows(epic) && lane_status(epic.canon_status) == status)
            .collect();
        let name = words.lane_label(status);
        let mut lane = KanbanLane::new(
            SharedString::from(format!("lane-{lane_id}")),
            format!("{name} · {}", cards.len()),
        )
        .lane_id(lane_id.clone())
        .label(format!("{} · {name}", plan.plan.title))
        .height(LaneHeight::Content);
        for (index, epic) in cards {
            lane = lane.child(lanes.card(epic, Some(index + 1), cx));
        }
        if status == CanonStatus::Planned {
            let id = format!("canon-new-epic-{}", plan.plan.id);
            let plan_id = Some(SharedString::from(plan.plan.id.clone()));
            lane = lane.child(lanes.new_epic(id, plan_id, cx));
        }
        board = board.child(lane);
    }
    Section::new(SharedString::from(format!("canon-plan-{}", plan.plan.id)))
        .title_element(title)
        .actions(actions)
        .child(board)
        .into_any_element()
}

/// The sideways scroller of a `KanbanBoard::scroll` board, which owns its handle (read by the
/// id the DS gives its `ScrollArea`, as `management_page::scroll_handle` does).
fn lanes_handle(board_id: &SharedString, window: &mut Window, cx: &mut App) -> ScrollHandle {
    let ds = Ds::get(cx);
    let config = Config {
        id: (ElementId::from(board_id.clone()), "scroll").into(),
        axis: Axis::X,
        size: ds.len(Length::ScrollFadeSize),
        guard: ds.len(Length::SpaceXs),
    };
    fade(&config, None, false, window, cx).handle
}

/// `scroll(direction)`: the previous/next lanes button, disabled at its edge.
fn lanes_arrow(
    board_id: &SharedString,
    handle: &ScrollHandle,
    direction: f32,
    at_edge: bool,
    words: &Words,
) -> AnyElement {
    let (label, glyph, side) = if direction < 0. {
        (words.previous_lanes, Icon::ArrowLeft, "previous")
    } else {
        (words.next_lanes, Icon::ArrowRight, "next")
    };
    let handle = handle.clone();
    let mut arrow = IconButton::new(SharedString::from(format!("{board_id}-{side}")), label)
        .glyph(glyph)
        .on_click(move |_, window, _| {
            // `board.scrollBy({ left: direction * board.clientWidth * 0.8 })`
            let step = direction * f32::from(handle.bounds().size.width) * 0.8;
            let offset = handle.offset();
            handle.set_offset(point(offset.x - gpui::px(step), offset.y));
            window.refresh();
        });
    if at_edge {
        arrow = arrow.disabled();
    }
    arrow.into_any_element()
}
