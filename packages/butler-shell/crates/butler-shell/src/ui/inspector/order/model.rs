//! `canonOrderModel`: the queue view as the step list reads it, and its edits as the API takes
//! them. Rows look their epic up by item id, so the list items carry no epic.
use std::collections::HashMap;

use butler_ds::ui::blocks::step_sortable_list::{
    StepSortableChain, StepSortableEdit, StepSortableEditKind, StepSortableItem,
    StepSortablePlacement, apply_step_sortable_edit,
};
use gpui::SharedString;

use crate::ui::source::wire::{
    CanonQueueChain, CanonQueueEdit, CanonQueueItem, CanonQueueItemState, CanonQueueStep,
    CanonQueueView,
};

/// `OrderAction["action"]`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum OrderActionKind {
    StartNow,
    Unstack,
    Remove,
}

/// `donePrefix`: the leading steps whose items are all done.
fn done_prefix(chain: &CanonQueueChain) -> usize {
    chain
        .steps
        .iter()
        .position(|step| {
            step.items
                .iter()
                .any(|item| item.state != CanonQueueItemState::Done)
        })
        .unwrap_or(chain.steps.len())
}

/// `faceRank`: which item of a stack shows in front (blocked, running, waiting, done).
fn face_rank(item: &CanonQueueItem) -> u8 {
    match item.state {
        CanonQueueItemState::Running if item.hold_reason.is_some() => 0,
        CanonQueueItemState::Running => 1,
        CanonQueueItemState::Done => 3,
        _ => 2,
    }
}

/// `orderChains`; the chain label is the origin's copy, set by the section.
pub(super) fn order_chains(view: &CanonQueueView) -> Vec<StepSortableChain> {
    view.chains
        .iter()
        .map(|chain| StepSortableChain {
            id: chain.chain_id.clone().into(),
            label: SharedString::default(),
            title: None,
            steps: chain.steps[done_prefix(chain)..]
                .iter()
                .map(|step| {
                    let mut items: Vec<&CanonQueueItem> = step.items.iter().collect();
                    items.sort_by_key(|item| face_rank(item));
                    items
                        .into_iter()
                        .map(|epic| {
                            let running = epic.state == CanonQueueItemState::Running;
                            let done = epic.state == CanonQueueItemState::Done;
                            StepSortableItem::new(epic.epic_id.clone(), epic.title.clone())
                                .running(running && epic.hold_reason.is_none())
                                .done(done)
                                .pinned(running || done)
                        })
                        .collect()
                })
                .collect(),
        })
        .collect()
}

/// `orderEditToApi`, the `"action" in edit` case.
pub(super) fn order_action_to_api(
    view: &CanonQueueView,
    action: OrderActionKind,
    epic_id: &str,
) -> CanonQueueEdit {
    CanonQueueEdit {
        expected_graph_revision: view.graph_revision,
        op: match action {
            OrderActionKind::StartNow => "start_now",
            OrderActionKind::Unstack => "split_stack",
            OrderActionKind::Remove => "delete",
        },
        epic_id: Some(epic_id.to_owned()),
        epic_ids: None,
        target_epic_id: None,
        index: None,
        target_chain_id: None,
    }
}

/// `orderEditToApi`, the drag case: the DS places precede removal; the API inserts after
/// removing the selection. `None` when the target chain is gone.
pub(super) fn order_edit_to_api(
    view: &CanonQueueView,
    edit: &StepSortableEdit,
) -> Option<CanonQueueEdit> {
    let chain = view
        .chains
        .iter()
        .find(|chain| chain.chain_id.as_str() == &*edit.to.chain_id)?;
    let offset = done_prefix(chain);
    let (from, to) = (edit.from.step_index, edit.to.step_index);
    let target = chain
        .steps
        .get(to + offset)
        .and_then(|step| step.items.first())
        .map(|item| item.epic_id.clone());
    let one = edit.item_ids.len() == 1;
    let mut api = CanonQueueEdit {
        expected_graph_revision: view.graph_revision,
        op: "",
        epic_id: one.then(|| edit.item_ids[0].to_string()),
        epic_ids: (!one).then(|| edit.item_ids.iter().map(ToString::to_string).collect()),
        target_epic_id: None,
        index: None,
        target_chain_id: None,
    };
    match edit.kind {
        StepSortableEditKind::MoveToNewStep => {
            api.op = "move_to_new_step";
            api.index = Some(offset + if to > from { to - 1 } else { to });
        }
        StepSortableEditKind::SplitStack => {
            api.op = "move_to_new_step";
            api.index = Some(offset + to);
        }
        StepSortableEditKind::JoinStack => {
            api.op = "join_stack";
            api.target_epic_id = target;
        }
        StepSortableEditKind::MoveBetween => {
            api.op = "move_between";
            api.target_chain_id = Some(edit.to.chain_id.to_string());
            if edit.placement == Some(StepSortablePlacement::Join) {
                api.target_epic_id = target;
            } else {
                api.index = Some(offset + to);
            }
        }
    }
    Some(api)
}

/// `optimisticOrder`: the view after the drag, in the API's whole-chain step indexes.
pub(super) fn optimistic_order(view: &CanonQueueView, edit: &StepSortableEdit) -> CanonQueueView {
    let offset = |id: &str| {
        view.chains
            .iter()
            .find(|chain| chain.chain_id == id)
            .map_or(0, done_prefix)
    };
    let epics: HashMap<&str, &CanonQueueItem> = view
        .chains
        .iter()
        .flat_map(|chain| &chain.steps)
        .flat_map(|step| &step.items)
        .map(|item| (item.epic_id.as_str(), item))
        .collect();
    let chains: Vec<StepSortableChain> = view
        .chains
        .iter()
        .map(|chain| StepSortableChain {
            id: chain.chain_id.clone().into(),
            label: chain.chain_id.clone().into(),
            title: None,
            steps: chain
                .steps
                .iter()
                .map(|step| {
                    step.items
                        .iter()
                        .map(|epic| StepSortableItem::new(epic.epic_id.clone(), epic.title.clone()))
                        .collect()
                })
                .collect(),
        })
        .collect();
    let mut shifted = edit.clone();
    shifted.from.step_index += offset(&edit.from.chain_id);
    shifted.to.step_index += offset(&edit.to.chain_id);
    let next = apply_step_sortable_edit(&chains, &shifted);
    CanonQueueView {
        chains: view
            .chains
            .iter()
            .map(|chain| CanonQueueChain {
                chain_id: chain.chain_id.clone(),
                origin: chain.origin,
                steps: next
                    .iter()
                    .find(|next| &*next.id == chain.chain_id.as_str())
                    .map(|next| &next.steps)
                    .into_iter()
                    .flatten()
                    .map(|step| CanonQueueStep {
                        items: step
                            .iter()
                            .filter_map(|item| epics.get(&*item.id).map(|epic| (*epic).clone()))
                            .collect(),
                    })
                    .collect(),
            })
            .collect(),
        ..view.clone()
    }
}

fn predecessor(chain: &CanonQueueChain, index: usize) -> Option<&CanonQueueStep> {
    index.checked_sub(1).and_then(|at| chain.steps.get(at))
}

/// `acceptsOrderEdit`: started steps, including blocked heads, retain their index and exact
/// predecessor membership.
pub(super) fn accepts_order_edit(view: &CanonQueueView, edit: &StepSortableEdit) -> bool {
    let next = optimistic_order(view, edit);
    let ids = |step: Option<&CanonQueueStep>| -> Vec<String> {
        let mut ids: Vec<String> = step
            .map(|step| step.items.iter().map(|item| item.epic_id.clone()).collect())
            .unwrap_or_default();
        ids.sort();
        ids
    };
    view.chains.iter().all(|chain| {
        let Some(target) = next
            .chains
            .iter()
            .find(|next| next.chain_id == chain.chain_id)
        else {
            return false;
        };
        chain.steps.iter().enumerate().all(|(index, step)| {
            let running = || {
                step.items
                    .iter()
                    .filter(|item| item.state == CanonQueueItemState::Running)
            };
            if running().next().is_none() {
                return true;
            }
            running().all(|item| {
                target
                    .steps
                    .get(index)
                    .is_some_and(|at| at.items.iter().any(|next| next.epic_id == item.epic_id))
            }) && ids(predecessor(chain, index)) == ids(predecessor(target, index))
        })
    })
}
