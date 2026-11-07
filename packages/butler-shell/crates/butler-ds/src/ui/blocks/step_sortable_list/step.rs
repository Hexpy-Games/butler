//! One step (`StepSortableStep.tsx`): a single item's card, or a 묶음 as a deck. A pointer
//! resting on the step for the dwell rings it (NavDropTarget group) to join it. A lifted step
//! stays in place at half strength.
use gpui::{
    AnyElement, App, InteractiveElement as _, IntoElement as _, ParentElement as _, Styled as _,
    Window, canvas, div,
};

use super::deck::{DeckArgs, deck};
use super::grip::{Grip, draggable};
use super::model::{StepSortableTargetKind, is_draggable};
use super::row::{RowArgs, row};
use super::session::{item_drag_id, step_key};
use super::{Env, StepSortableChain, StepSortableItem, StepSortableRowContext, sub};
use crate::tokens::Length;
use crate::ui::blocks::nav_drop::{NavDropPosition, NavDropScope, NavDropTarget, Payload};
use crate::ui::card::Card;
use crate::ui::context::Ds;

/// The accent line where a drop makes a new step ("새 단계"); follow-up steps indent it with them.
pub(super) fn gap(follow: bool, cx: &App) -> AnyElement {
    use crate::ui::layout::Space;
    use crate::ui::separator::{Separator, SeparatorTone};
    let line = Separator::new()
        .tone(SeparatorTone::Accent)
        .space(Space::None);
    let el = div().w_full().min_w_0();
    if follow {
        el.pl(Ds::get(cx).len(Length::SpaceMd))
            .child(line)
            .into_any_element()
    } else {
        el.child(line).into_any_element()
    }
}

/// The context of a step's rows before the card-specific fields.
fn context(chain: &StepSortableChain, index: usize, count: usize) -> StepSortableRowContext {
    StepSortableRowContext {
        chain_id: chain.id.clone(),
        step_index: index,
        step_number: index + 1,
        count,
        expanded: false,
        lifted: false,
        outcome: None,
    }
}

/// A single item's card: not interactive; only its grip and ⋯ are.
fn single(
    env: &Env,
    (item, ctx): (&StepSortableItem, StepSortableRowContext),
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let drag_id = item_drag_id(&item.id);
    let grip = Grip {
        drag_id: drag_id.clone(),
        label: item.label.clone(),
        movable: is_draggable(item),
    };
    let content = row(
        env,
        RowArgs {
            item,
            ctx,
            grip: Some(grip),
            marker: true,
            dim: false,
        },
        window,
        cx,
    );
    let mut card = Card::new(sub(&env.id, "card", &item.id));
    if item.running {
        card = card.running();
    }
    let wrap = div()
        .id(sub(&env.id, "single", &item.id))
        .w_full()
        .child(card.child(content));
    draggable(wrap, env, &drag_id, is_draggable(item)).into_any_element()
}

pub(super) fn step(
    env: &Env,
    chain: &StepSortableChain,
    step: &[StepSortableItem],
    index: usize,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let first = &step[0];
    let key = step_key(&chain.id, index);
    let view = &env.view;
    let joining = view.target.as_ref().is_some_and(|target| {
        target.kind == StepSortableTargetKind::Join
            && target.chain_id == chain.id
            && target.step_index == index
    });
    let lifted = view.mode.is_some() && step.iter().all(|item| view.item_ids.contains(&item.id));
    let base = context(chain, index, step.len());
    let body = if step.len() == 1 {
        single(env, (first, base), window, cx)
    } else {
        let args = DeckArgs {
            step,
            expanded: env.fanned.contains(&first.id),
            interactive: view.mode.is_none(),
            base,
        };
        deck(env, &args, window, cx)
    };
    // The ring keeps the height frozen at drag start; a static preview measures the step once.
    let mut target = NavDropTarget::new(key.clone(), body)
        .drop(joining.then_some(NavDropPosition::Group))
        .dragging(lifted);
    if let Some(height) = env.heights.get(&key) {
        target = target.indicator(0., *height);
    }
    let scope = NavDropScope::new(sub(&env.id, "step", &key))
        .payload(Payload::Outside)
        .row(target);
    let hub = env.hub.clone();
    let recorded = key.clone();
    let record = canvas(
        |bounds, _, _| bounds,
        move |_, bounds, _, _| {
            hub.borrow_mut().boxes.insert(recorded.clone(), bounds);
        },
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full();
    let el = div().relative().w_full().min_w_0();
    let el = if index > 0 {
        el.pl(Ds::get(cx).len(Length::SpaceMd))
    } else {
        el
    };
    el.child(scope).child(record).into_any_element()
}
