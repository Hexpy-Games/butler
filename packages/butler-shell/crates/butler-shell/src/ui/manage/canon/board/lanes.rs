//! The lane model of the board (`canonLanes.ts`): lane ids, the order a move leaves, and the
//! board as a move would leave it.
use std::collections::HashMap;

use butler_ds::ui::blocks::kanban_board::{KanbanMove, apply_kanban_move};
use gpui::SharedString;

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
    match plan {
        Some(plan) => format!("{plan}:{}", status_name(status)),
        None => "backlog".to_owned(),
    }
}

/// `parseCanonLane`
pub(super) struct Lane {
    pub(super) plan: Option<String>,
    pub(super) status: Option<CanonStatus>,
}

pub(super) fn parse_canon_lane(id: &str) -> Option<Lane> {
    if id == "backlog" {
        return Some(Lane {
            plan: None,
            status: None,
        });
    }
    let separator = id.rfind(':').filter(|at| *at >= 1)?;
    let name = &id[separator + 1..];
    let status = CANON_LANES
        .into_iter()
        .find(|status| status_name(*status) == name)?;
    Some(Lane {
        plan: Some(id[..separator].to_owned()),
        status: Some(status),
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
            let last = cards.iter().rfind(|card| {
                card.id != spec.item
                    && status.is_none_or(|status| lane_status(card.canon_status) == status)
            });
            let after = last.and_then(|last| ids.iter().position(|id| *id == last.id));
            Some(after.map_or(ids.len(), |at| at + 1))
        }
    };
    ids.insert(at.unwrap_or(ids.len()), spec.item.clone());
    Some(ids)
}

fn lane_ids<'a>(cards: impl Iterator<Item = &'a EpicCard>) -> Vec<SharedString> {
    cards
        .map(|card| SharedString::from(card.id.clone()))
        .collect()
}

/// `optimisticCanonMove`: the board as the move leaves it.
pub(super) fn optimistic_canon_move(
    canon: &CanonOverview,
    mv: &KanbanMove,
) -> Option<CanonOverview> {
    let spec = Spec::of(mv);
    let epic = find_card(canon, &spec.item)?;
    let target = parse_canon_lane(&spec.to)?;
    let mut lanes = vec![(
        SharedString::from("backlog"),
        lane_ids(canon.backlog.iter()),
    )];
    for plan in &canon.plans {
        for status in CANON_LANES {
            let id = canon_lane_id(Some(&plan.plan.id), status);
            let cards = plan
                .works
                .iter()
                .filter(|card| lane_status(card.canon_status) == status);
            lanes.push((id.into(), lane_ids(cards)));
        }
    }
    let moved = apply_kanban_move(&lanes, mv);
    let mut updated = epic.clone();
    updated.plan_id.clone_from(&target.plan);
    if let Some(status) = target.status
        && status != lane_status(epic.canon_status)
    {
        updated.canon_status = status;
    }
    let by_id: HashMap<String, EpicCard> = canon_cards(canon)
        .map(|card| {
            let card = if card.id == spec.item { &updated } else { card };
            (card.id.clone(), card.clone())
        })
        .collect();
    let cards_of = |ids: Vec<String>| -> Vec<EpicCard> {
        ids.iter().filter_map(|id| by_id.get(id).cloned()).collect()
    };
    let mut next = canon.clone();
    let backlog = moved.iter().find(|(id, _)| &**id == "backlog");
    next.backlog = cards_of(
        backlog
            .map(|(_, ids)| ids.iter().map(ToString::to_string).collect())
            .unwrap_or_default(),
    );
    for (plan, source) in next.plans.iter_mut().zip(&canon.plans) {
        plan.works = if target.plan.as_deref() == Some(plan.plan.id.as_str()) {
            cards_of(moved_canon_order(&source.works, &spec)?)
        } else {
            source
                .works
                .iter()
                .filter(|card| card.id != spec.item)
                .cloned()
                .collect()
        };
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
        Some(lane) => lane.status != Some(CanonStatus::Done) || can_finish(card),
        None => false,
    }
}
