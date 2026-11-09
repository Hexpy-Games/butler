//! DS SortableCardList (`blocks/SortableCardList/`): a titled, reorderable column of cards with
//! optional remove buttons. A card is picked up by its grip (a gpui pointer drag; React uses
//! dnd-kit), lifts under the pointer and drops into the place of the row nearest the pointer;
//! a `Separator` marks that place. The grip also takes the arrow keys: up and down move the
//! card one place. The block reports the new order of ids ([`SortableCardList::on_reorder`]);
//! the product owns the list.
//!
//! Not reproduced: the neighbours sliding aside while dragging (the dragged card stays in
//! place, dimmed, and the indicator shows where it lands), the lift's scale, the keyboard
//! lift/cancel (Space, Escape: an arrow moves at once), the screen-reader live region, the
//! `empty` node (text only, `empty_message`), and the 6 px drag activation (gpui starts a drag
//! after 2 px). A card's title, description and actions can be element slots ([`Slot`]), as
//! React's `ReactNode` props are.
mod copy;
mod drag;
mod row;

use std::cell::RefCell;
use std::rc::Rc;

use gpui::{
    AnyElement, App, ElementId, InteractiveElement as _, IntoElement, ParentElement as _,
    RenderOnce, SharedString, Styled as _, Window, div,
};

use drag::{Drag, Hub, OnReorder, Session, finish, pointer_update};

use crate::tokens::Length;
use crate::ui::Icon;
use crate::ui::blocks::empty_line::EmptyLine;
use crate::ui::context::{Ds, Lang};
use crate::ui::layout::{Cross, Justify, Space, Stack};
use crate::ui::typo::{Tone, Typo};

type OnRemove = Rc<dyn Fn(&SharedString, &mut Window, &mut App)>;

/// A node of a card (React's `ReactNode` props), built each time the row or its lifted copy
/// paints. Two slots are equal when they are the same slot.
#[derive(Clone)]
pub struct Slot(Build);

type Build = Rc<dyn Fn(&mut Window, &mut App) -> AnyElement>;

impl Slot {
    pub fn new(build: impl Fn(&mut Window, &mut App) -> AnyElement + 'static) -> Self {
        Self(Rc::new(build))
    }

    fn build(&self, window: &mut Window, cx: &mut App) -> AnyElement {
        (self.0)(window, cx)
    }
}

impl std::fmt::Debug for Slot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Slot")
    }
}

impl PartialEq for Slot {
    fn eq(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.0, &other.0)
    }
}

impl Eq for Slot {}

/// A card of the list (`SortableCardItemData`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SortableCardItem {
    pub id: SharedString,
    /// The accessible name in the grip and remove buttons; the title when absent.
    pub label: Option<SharedString>,
    pub title: SharedString,
    pub description: Option<SharedString>,
    pub meta: Option<SharedString>,
    pub leading: Option<Icon>,
    /// Replaces `title` in the card (the title stays the accessible name).
    pub title_element: Option<Slot>,
    /// Replaces `description` in the card.
    pub description_element: Option<Slot>,
    /// Controls at the card's trailing edge, before the remove button.
    pub actions: Option<Slot>,
}

impl SortableCardItem {
    pub fn new(id: impl Into<SharedString>, title: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            label: None,
            title: title.into(),
            description: None,
            meta: None,
            leading: None,
            title_element: None,
            description_element: None,
            actions: None,
        }
    }

    pub fn label(mut self, label: impl Into<SharedString>) -> Self {
        self.label = Some(label.into());
        self
    }

    pub fn description(mut self, description: impl Into<SharedString>) -> Self {
        self.description = Some(description.into());
        self
    }

    pub fn meta(mut self, meta: impl Into<SharedString>) -> Self {
        self.meta = Some(meta.into());
        self
    }

    pub fn leading(mut self, leading: Icon) -> Self {
        self.leading = Some(leading);
        self
    }

    pub fn title_element(
        mut self,
        build: impl Fn(&mut Window, &mut App) -> AnyElement + 'static,
    ) -> Self {
        self.title_element = Some(Slot::new(build));
        self
    }

    pub fn description_element(
        mut self,
        build: impl Fn(&mut Window, &mut App) -> AnyElement + 'static,
    ) -> Self {
        self.description_element = Some(Slot::new(build));
        self
    }

    pub fn actions(
        mut self,
        build: impl Fn(&mut Window, &mut App) -> AnyElement + 'static,
    ) -> Self {
        self.actions = Some(Slot::new(build));
        self
    }
}

/// What one frame of the list is built from.
struct Env {
    id: ElementId,
    hub: Hub,
    disabled: bool,
    on_remove: Option<OnRemove>,
    lang: Lang,
}

/// A child id of `id`: `(id, tag, key)`.
fn sub(id: &ElementId, tag: &'static str, key: &str) -> ElementId {
    let tagged: ElementId = (id.clone(), tag).into();
    (tagged, SharedString::from(key.to_owned())).into()
}

#[derive(IntoElement)]
pub struct SortableCardList {
    id: ElementId,
    items: Vec<SortableCardItem>,
    title: Option<SharedString>,
    description: Option<SharedString>,
    actions: Option<AnyElement>,
    empty_message: Option<SharedString>,
    disabled: bool,
    on_reorder: Option<OnReorder>,
    on_remove: Option<OnRemove>,
}

impl SortableCardList {
    pub fn new(id: impl Into<ElementId>, items: Vec<SortableCardItem>) -> Self {
        Self {
            id: id.into(),
            items,
            title: None,
            description: None,
            actions: None,
            empty_message: None,
            disabled: false,
            on_reorder: None,
            on_remove: None,
        }
    }

    pub fn title(mut self, title: impl Into<SharedString>) -> Self {
        self.title = Some(title.into());
        self
    }

    pub fn description(mut self, description: impl Into<SharedString>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// Trailing controls in the header row.
    pub fn actions(mut self, actions: impl IntoElement) -> Self {
        self.actions = Some(actions.into_any_element());
        self
    }

    /// Shown when there are no cards (`No cards configured yet.` by default).
    pub fn empty_message(mut self, message: impl Into<SharedString>) -> Self {
        self.empty_message = Some(message.into());
        self
    }

    /// Lock every card in place and disable the buttons.
    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// A drop or an arrow key moved a card: the new order of ids. The product applies it.
    pub fn on_reorder(
        mut self,
        handler: impl Fn(Vec<SharedString>, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_reorder = Some(Rc::new(handler));
        self
    }

    /// Shows a remove button on every card.
    pub fn on_remove(
        mut self,
        handler: impl Fn(&SharedString, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_remove = Some(Rc::new(handler));
        self
    }
}

/// A drag that ended outside the list is a cancel.
fn settle(hub: &Hub, window: &mut Window, cx: &mut App) {
    if hub.borrow().active.is_some() && !cx.has_active_drag() {
        finish(hub, false, window, cx);
    }
}

impl RenderOnce for SortableCardList {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let hub = window
            .use_keyed_state((self.id.clone(), "hub"), cx, |_, _| {
                Rc::new(RefCell::new(Session::default()))
            })
            .read(cx)
            .clone();
        {
            let mut session = hub.borrow_mut();
            session.order = self.items.iter().map(|item| item.id.clone()).collect();
            session.on_reorder = self.on_reorder;
            let order = session.order.clone();
            session.rows.retain(|id, _| order.contains(id));
        }
        settle(&hub, window, cx);
        let lang = Ds::get(cx).lang();
        let header = (self.title.is_some() || self.description.is_some() || self.actions.is_some())
            .then(|| {
                let heading = Stack::new()
                    .gap(Space::Xs)
                    .children(self.title.map(Typo::body))
                    .children(
                        self.description
                            .map(|text| Typo::caption(text).tone(Tone::Secondary)),
                    );
                Stack::row()
                    .gap(Space::Md)
                    .cross(Cross::Start)
                    .justify(Justify::Between)
                    .child(div().flex_auto().min_w_0().child(heading))
                    .children(self.actions)
            });
        let body = if self.items.is_empty() {
            let message = self
                .empty_message
                .unwrap_or_else(|| copy::empty(lang).into());
            EmptyLine::new(message).into_any_element()
        } else {
            let env = Env {
                id: self.id.clone(),
                hub: hub.clone(),
                disabled: self.disabled,
                on_remove: self.on_remove,
                lang,
            };
            let rows: Vec<AnyElement> = self
                .items
                .iter()
                .map(|item| row::live(&env, item, window, cx))
                .collect();
            items(&self.id, &hub, rows, cx)
        };
        let gap = Ds::get(cx).len(Length::Space3);
        div()
            .flex()
            .flex_col()
            .w_full()
            .min_w_0()
            .gap(gap)
            .children(header)
            .child(body)
    }
}

/// The cards column; a drag over it follows the pointer and a drop on it reorders.
fn items(id: &ElementId, hub: &Hub, rows: Vec<AnyElement>, cx: &App) -> AnyElement {
    let gap = Ds::get(cx).len(Length::Space2);
    let (moving, dropping) = (hub.clone(), hub.clone());
    let (list, dropped) = (id.clone(), id.clone());
    div()
        .id((id.clone(), "items"))
        .flex()
        .flex_col()
        .w_full()
        .min_w_0()
        .gap(gap)
        .on_drag_move::<Drag>(move |event, window, cx| {
            if event.drag(cx).list == list {
                pointer_update(&moving, f32::from(event.event.position.y));
                window.refresh();
            }
        })
        .on_drop::<Drag>(move |drag, window, cx| {
            if drag.list == dropped {
                finish(&dropping, true, window, cx);
                window.refresh();
            }
        })
        .children(rows)
        .into_any_element()
}
