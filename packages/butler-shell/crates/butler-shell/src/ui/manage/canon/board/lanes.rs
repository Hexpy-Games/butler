//! The lane model of the board (`canonLanes.ts`): lane ids, the order a move leaves, and the
//! board as a move would leave it.
use std::collections::HashMap;

use butler_ds::ui::blocks::kanban_board::KanbanMove;

use crate::ui::source::wire::{CanonOverview, CanonStatus, EpicCard};

/// `CANON_LANES`
pub(super) const CANON_LANES: [CanonStatus; 5] = [
    CanonStatus::Planned,
    CanonStatus::InProgress,
    CanonStatus::InReview,
    CanonStatus::Blocked,
    CanonStatus::Done,
];

pub(super) fn status_name(status: CanonStatus) -> &'static str {
    match status {
        CanonStatus::Planned => "planned",
        CanonStatus::InProgress => "in_progress",
        CanonStatus::InReview => "in_review",
        CanonStatus::Blocked => "blocked",
        CanonStatus::Done => "done",
        CanonStatus::Cancelled => "cancelled",
        CanonStatus::Unknown => "unknown",
    }
}

/// `laneStatus`: a cancelled epic sits in the done lane.
pub(super) fn lane_status(status: CanonStatus) -> CanonStatus {
    if status == CanonStatus::Cancelled {
        CanonStatus::Done
    } else {
        status
    }
}

/// `canonLaneId`
pub(super) fn canon_lane_id(plan: Option<&str>, status: CanonStatus) -> String {
    format!("{}:{}", plan.unwrap_or("backlog"), status_name(status))
}

/// `parseCanonLane`
pub(super) struct Lane {
    pub(super) plan: Option<String>,
    pub(super) status: CanonStatus,
}

pub(super) fn parse_canon_lane(id: &str) -> Option<Lane> {
    let separator = id.rfind(':').filter(|at| *at >= 1)?;
    let name = &id[separator + 1..];
    let status = CANON_LANES
        .into_iter()
        .find(|status| status_name(*status) == name)?;
    Some(Lane {
        plan: (&id[..separator] != "backlog").then(|| id[..separator].to_owned()),
        status,
    })
}

/// `canonCards`
pub(super) fn canon_cards(canon: &CanonOverview) -> impl Iterator<Item = &EpicCard> {
    canon
        .backlog
        .iter()
        .chain(canon.plans.iter().flat_map(|plan| plan.works.iter()))
}

pub(super) fn find_card<'a>(canon: &'a CanonOverview, id: &str) -> Option<&'a EpicCard> {
    canon_cards(canon).find(|card| card.id == id)
}

/// A drop as plain strings.
pub(super) struct Spec {
    pub(super) item: String,
    pub(super) from: String,
    pub(super) to: String,
    pub(super) before: Option<String>,
}

impl Spec {
    pub(super) fn of(mv: &KanbanMove) -> Self {
        Self {
            item: (*mv.item_id).to_owned(),
            from: (*mv.from_lane_id).to_owned(),
            to: (*mv.to_lane_id).to_owned(),
            before: mv.before_item_id.as_deref().map(str::to_owned),
        }
    }
}

/// `movedCanonOrder`: the complete interleaved order, including the cards of other lanes.
pub(super) fn moved_canon_order(cards: &[EpicCard], spec: &Spec) -> Option<Vec<String>> {
    let mut ids: Vec<String> = cards
        .iter()
        .filter(|card| card.id != spec.item)
        .map(|card| card.id.clone())
        .collect();
    let at = match &spec.before {
        Some(before) => ids.iter().position(|id| id == before),
        None => {
            let status = parse_canon_lane(&spec.to)?.status;
            let last = cards
                .iter()
                .rfind(|card| card.id != spec.item && lane_status(card.canon_status) == status);
            let after = last.and_then(|last| ids.iter().position(|id| *id == last.id));
            Some(after.map_or(ids.len(), |at| at + 1))
        }
    };
    ids.insert(at.unwrap_or(ids.len()), spec.item.clone());
    Some(ids)
}

/// `optimisticCanonMove`: the board as the move leaves it.
pub(super) fn optimistic_canon_move(
    canon: &CanonOverview,
    mv: &KanbanMove,
) -> Option<CanonOverview> {
    let spec = Spec::of(mv);
    let epic = find_card(canon, &spec.item)?;
    let target = parse_canon_lane(&spec.to)?;
    let mut updated = epic.clone();
    updated.plan_id.clone_from(&target.plan);
    if target.status != lane_status(epic.canon_status) {
        updated.canon_status = target.status;
    }
    let by_id: HashMap<String, EpicCard> = canon_cards(canon)
        .map(|card| {
            let card = if card.id == spec.item { &updated } else { card };
            (card.id.clone(), card.clone())
        })
        .collect();
    let place = |works: &[EpicCard], plan: Option<&str>| -> Option<Vec<EpicCard>> {
        if plan == target.plan.as_deref() {
            Some(
                moved_canon_order(works, &spec)?
                    .iter()
                    .filter_map(|id| by_id.get(id).cloned())
                    .collect(),
            )
        } else {
            Some(
                works
                    .iter()
                    .filter(|card| card.id != spec.item)
                    .cloned()
                    .collect(),
            )
        }
    };
    let mut next = canon.clone();
    next.backlog = place(&canon.backlog, None)?;
    for plan in &mut next.plans {
        plan.works = place(&plan.works, Some(&plan.plan.id))?;
    }
    Some(next)
}

/// `canFinishCanonEpic`
fn can_finish(card: &EpicCard) -> bool {
    !card.running
}

/// `canComplete`: a running epic cannot move into the done lane.
pub(super) fn can_complete(card: Option<&EpicCard>, to_lane: &str) -> bool {
    let Some(card) = card else {
        return false;
    };
    match parse_canon_lane(to_lane) {
        Some(lane) => lane.status != CanonStatus::Done || can_finish(card),
        None => false,
    }
}
