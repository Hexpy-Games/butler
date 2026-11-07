//! The order model of a StepSortableList (`stepSortableModel.ts`): chains of steps, each step one
//! item or a flat 묶음 (stack) of items (stacks never nest). A drag carries one item, or a whole
//! step (a collapsed 묶음 drags as one); its drop resolves to a target (a gap between steps, or a
//! step to join) and becomes one semantic edit. Every index is the place in the chains BEFORE the
//! edit.
use gpui::SharedString;

/// One item of a step. `id` is stable; edits report it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StepSortableItem {
    pub id: SharedString,
    /// Name for announcements and the grip's label (usually the title).
    pub label: SharedString,
    /// Running: pinned (no grip, never dragged) and drawn in the running colour.
    pub running: bool,
    /// Pinned without running: not draggable.
    pub pinned: bool,
    /// Finished: the row is muted.
    pub done: bool,
}

impl StepSortableItem {
    pub fn new(id: impl Into<SharedString>, label: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            running: false,
            pinned: false,
            done: false,
        }
    }

    pub fn running(mut self, running: bool) -> Self {
        self.running = running;
        self
    }

    pub fn pinned(mut self, pinned: bool) -> Self {
        self.pinned = pinned;
        self
    }

    pub fn done(mut self, done: bool) -> Self {
        self.done = done;
        self
    }
}

/// An ordered chain: a head followed by its follow-up steps.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StepSortableChain {
    pub id: SharedString,
    /// Chain name for announcements.
    pub label: SharedString,
    /// Optional heading shown above the chain (a caption line).
    pub title: Option<SharedString>,
    /// Steps in order (the first is the chain's head); a step with two or more items is a 묶음.
    /// No empty steps.
    pub steps: Vec<Vec<StepSortableItem>>,
}

/// A place in a chain: a step index before the edit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StepSortablePlace {
    pub chain_id: SharedString,
    pub step_index: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StepSortableTargetKind {
    /// A new step lands before step `step_index` (`steps.len()`: after the last).
    Gap,
    /// The items join step `step_index`'s 묶음, at its end (flat).
    Join,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StepSortableTarget {
    pub chain_id: SharedString,
    pub step_index: usize,
    pub kind: StepSortableTargetKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StepSortableEditKind {
    /// A whole step moves to a new place in its chain.
    MoveToNewStep,
    /// Items leave their 묶음 for a new step of their own in the same chain.
    SplitStack,
    /// Items join another step of their chain (flat).
    JoinStack,
    /// Items move to another chain, as a new step or into a step.
    MoveBetween,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StepSortablePlacement {
    NewStep,
    Join,
}

/// The edit a drop makes. `item_ids`: the dragged item, or every item of a dragged step. `from` is
/// their step, `to` the gap (new step) or the joined step.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StepSortableEdit {
    pub kind: StepSortableEditKind,
    pub item_ids: Vec<SharedString>,
    pub from: StepSortablePlace,
    pub to: StepSortablePlace,
    /// Set for `MoveBetween` only.
    pub placement: Option<StepSortablePlacement>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Location {
    pub chain_index: usize,
    pub step_index: usize,
    pub item_index: usize,
}

pub(super) fn locate_item(chains: &[StepSortableChain], item_id: &str) -> Option<Location> {
    chains.iter().enumerate().find_map(|(chain_index, chain)| {
        chain
            .steps
            .iter()
            .enumerate()
            .find_map(|(step_index, step)| {
                let item_index = step.iter().position(|item| &*item.id == item_id)?;
                Some(Location {
                    chain_index,
                    step_index,
                    item_index,
                })
            })
    })
}

pub(super) fn is_draggable(item: &StepSortableItem) -> bool {
    !item.running && !item.pinned
}

/// A step with a running or pinned item stays put: it never drags as a whole and takes no joins.
pub(super) fn is_pinned_step(step: &[StepSortableItem]) -> bool {
    step.iter().any(|item| !is_draggable(item))
}

/// The edit a drop of `item_ids` (one item, or a whole step) on `target` makes; `None` when
/// nothing changes or the target is refused.
pub(super) fn edit_for(
    chains: &[StepSortableChain],
    item_ids: &[SharedString],
    target: &StepSortableTarget,
) -> Option<StepSortableEdit> {
    let at = locate_item(chains, item_ids.first()?)?;
    let chain = chains.iter().find(|chain| chain.id == target.chain_id)?;
    let source = &chains[at.chain_index];
    let step = &source.steps[at.step_index];
    if !item_ids
        .iter()
        .all(|id| step.iter().any(|item| &item.id == id))
    {
        return None;
    }
    let join = target.kind == StepSortableTargetKind::Join;
    let limit = if join {
        chain.steps.len().checked_sub(1)?
    } else {
        chain.steps.len()
    };
    if target.step_index > limit {
        return None;
    }
    if join && is_pinned_step(&chain.steps[target.step_index]) {
        return None;
    }
    if !join
        && target.step_index == 0
        && chain.steps.first().is_some_and(|first| is_pinned_step(first))
    {
        return None;
    }
    let edit = |kind, placement| StepSortableEdit {
        kind,
        item_ids: item_ids.to_vec(),
        from: StepSortablePlace {
            chain_id: source.id.clone(),
            step_index: at.step_index,
        },
        to: StepSortablePlace {
            chain_id: chain.id.clone(),
            step_index: target.step_index,
        },
        placement,
    };
    if source.id != chain.id {
        let placement = if join {
            StepSortablePlacement::Join
        } else {
            StepSortablePlacement::NewStep
        };
        return Some(edit(StepSortableEditKind::MoveBetween, Some(placement)));
    }
    if join {
        return (target.step_index != at.step_index)
            .then(|| edit(StepSortableEditKind::JoinStack, None));
    }
    if item_ids.len() < step.len() {
        return Some(edit(StepSortableEditKind::SplitStack, None));
    }
    let stays = target.step_index == at.step_index || target.step_index == at.step_index + 1;
    (!stays).then(|| edit(StepSortableEditKind::MoveToNewStep, None))
}

/// Applies an edit (optimistic product state). A step left empty is removed.
pub fn apply_step_sortable_edit(
    chains: &[StepSortableChain],
    edit: &StepSortableEdit,
) -> Vec<StepSortableChain> {
    let mut next = chains.to_vec();
    let source = next.iter().position(|chain| chain.id == edit.from.chain_id);
    let target = next.iter().position(|chain| chain.id == edit.to.chain_id);
    let (Some(source), Some(target)) = (source, target) else {
        return next;
    };
    let Some(step) = next[source].steps.get(edit.from.step_index).cloned() else {
        return next;
    };
    let moved: Vec<_> = step
        .iter()
        .filter(|item| edit.item_ids.contains(&item.id))
        .cloned()
        .collect();
    if moved.is_empty() {
        return next;
    }
    let left: Vec<_> = step
        .into_iter()
        .filter(|item| !edit.item_ids.contains(&item.id))
        .collect();
    let mut index = edit.to.step_index;
    if left.is_empty() {
        next[source].steps.remove(edit.from.step_index);
        if source == target && edit.from.step_index < index {
            index -= 1;
        }
    } else {
        next[source].steps[edit.from.step_index] = left;
    }
    let join = edit.kind == StepSortableEditKind::JoinStack
        || (edit.kind == StepSortableEditKind::MoveBetween
            && edit.placement == Some(StepSortablePlacement::Join));
    let steps = &mut next[target].steps;
    if join {
        if let Some(step) = steps.get_mut(index) {
            step.extend(moved);
        }
    } else {
        steps.insert(index.min(steps.len()), moved);
    }
    next
}

/// Every place a keyboard drag visits, in reading order: per chain the gap before each step, the
/// step itself (join), and the gap after the last step.
pub(super) fn keyboard_targets(chains: &[StepSortableChain]) -> Vec<StepSortableTarget> {
    let at = |chain: &StepSortableChain, step_index, kind| StepSortableTarget {
        chain_id: chain.id.clone(),
        step_index,
        kind,
    };
    chains
        .iter()
        .flat_map(|chain| {
            let steps = (0..chain.steps.len()).flat_map(move |index| {
                [
                    at(chain, index, StepSortableTargetKind::Gap),
                    at(chain, index, StepSortableTargetKind::Join),
                ]
            });
            let last = at(chain, chain.steps.len(), StepSortableTargetKind::Gap);
            steps.chain(std::iter::once(last))
        })
        .collect()
}

/// Where the moved items end up after `edit`: their chain's label and 1-based step number.
pub(super) fn result_place(
    chains: &[StepSortableChain],
    edit: &StepSortableEdit,
) -> Option<(SharedString, usize)> {
    let next = apply_step_sortable_edit(chains, edit);
    let at = locate_item(&next, edit.item_ids.first()?)?;
    Some((next[at.chain_index].label.clone(), at.step_index + 1))
}
