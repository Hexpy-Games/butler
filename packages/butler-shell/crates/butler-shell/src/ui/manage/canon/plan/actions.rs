//! `PlanEpicActions.tsx`: a plan row's status select and ⋯ menu (open the conversation, change
//! the plan, delete).
use gpui::Styled as _;
use std::rc::Rc;

use butler_ds::ui::Icon;
use butler_ds::ui::button::{self, Size};
use butler_ds::ui::context::Ds;
use butler_ds::ui::dropdown_menu::{
    DropdownMenu, DropdownMenuContent, Item, Sub, Variant as ItemVariant,
};
use butler_ds::ui::icon_button::IconButton;
use butler_ds::ui::native_select::{NativeSelect, Size as SelectSize};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, SharedString, Window, div};

use super::copy::{Words, words};
use crate::ui::source::wire::{CanonPlan, CanonStatus, EpicCard, EpicInput, Patch};

/// The status select's options, in `canon.statuses` order.
const STATUSES: [CanonStatus; 6] = [
    CanonStatus::Planned,
    CanonStatus::InProgress,
    CanonStatus::InReview,
    CanonStatus::Blocked,
    CanonStatus::Done,
    CanonStatus::Cancelled,
];

/// What a row asks of the page (`onWrite`, `onOpen`, `deletion.request`).
pub(super) enum Act {
    /// A write of the epic, and the toast that follows it.
    Write(EpicInput, SharedString),
    Open,
    Delete,
}

pub(super) type OnAct = Rc<dyn Fn(&EpicCard, Act, &mut App)>;

/// `PlanEpicActions`
pub(super) fn epic_actions(
    epic: &EpicCard,
    plans: &[CanonPlan],
    busy: bool,
    on_act: &OnAct,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let copy = words(Ds::get(cx).lang());
    let id = |part: &str| SharedString::from(format!("canon-plan-epic-{part}-{}", epic.id));
    let mut select = NativeSelect::new(id("status")).size(SelectSize::Sm).value(
        STATUSES
            .iter()
            .position(|status| *status == epic.canon_status)
            .map_or_else(String::new, |index| index.to_string()),
    );
    for (index, label) in copy.statuses.iter().enumerate() {
        select = select.option(index.to_string(), *label);
    }
    if busy {
        select = select.disabled();
    }
    let (card, handler) = (epic.clone(), on_act.clone());
    let select = select.on_change(move |picked, _, cx| {
        let Some(status) = picked
            .parse::<usize>()
            .ok()
            .and_then(|index| STATUSES.get(index))
            .copied()
        else {
            return;
        };
        let input = EpicInput {
            expected_revision: Some(card.revision),
            status: Some(status),
            ..EpicInput::default()
        };
        handler(&card, Act::Write(input, copy.status_changed.into()), cx);
    });
    let menu = DropdownMenu::new(id("menu"), window, cx);
    let label = (copy.row_menu)(&epic.title);
    let trigger = menu.trigger(|toggle| {
        let button = IconButton::new(id("menu-trigger"), label)
            .glyph(Icon::MoreHorizontal)
            .menu_trigger()
            .on_click(toggle.on_click());
        (if busy { button.disabled() } else { button }).into_any_element()
    });
    let content = menu.content(
        DropdownMenuContent::new()
            .child(open_item(epic, copy, on_act))
            .child(plan_sub(epic, plans, copy, on_act))
            .child(delete_item(epic, busy, copy, on_act)),
        window,
        cx,
    );
    button::container(Size::Sm)
        .child(select)
        .child(div().flex().child(trigger).child(content))
        .into_any_element()
}

fn open_item(epic: &EpicCard, copy: &'static Words, on_act: &OnAct) -> Item {
    let (card, handler) = (epic.clone(), on_act.clone());
    let item =
        Item::new(copy.open_conversation).on_select(move |_, cx| handler(&card, Act::Open, cx));
    if epic.home_session_id.is_some() {
        item
    } else {
        item.disabled()
    }
}

/// `changePlan`: the backlog and every plan; the epic's own is disabled.
fn plan_sub(epic: &EpicCard, plans: &[CanonPlan], copy: &'static Words, on_act: &OnAct) -> Sub {
    let mut sub = Sub::new(copy.change_plan);
    let options = std::iter::once((None, copy.backlog.to_owned())).chain(
        plans
            .iter()
            .map(|plan| (Some(plan.id.clone()), plan.title.clone())),
    );
    for (target, title) in options {
        let current = epic.plan_id == target;
        let (card, handler, name) = (epic.clone(), on_act.clone(), title.clone());
        let item = Item::new(title).on_select(move |_, cx| {
            let input = EpicInput {
                expected_revision: Some(card.revision),
                plan_id: target.clone().map_or(Patch::Clear, Patch::Set),
                ..EpicInput::default()
            };
            handler(&card, Act::Write(input, (copy.moved)(&name).into()), cx);
        });
        sub = sub.child(if current { item.disabled() } else { item });
    }
    sub
}

fn delete_item(epic: &EpicCard, busy: bool, copy: &'static Words, on_act: &OnAct) -> Item {
    let (card, handler) = (epic.clone(), on_act.clone());
    let blocked = epic.delete_blocked == Some(true);
    let mut item = Item::new(copy.delete)
        .variant(ItemVariant::Destructive)
        .on_select(move |_, cx| handler(&card, Act::Delete, cx));
    if blocked {
        item = item.description([copy.delete_running.into()]);
    }
    if busy || blocked {
        item = item.disabled();
    }
    item
}
