//! DS BlockActionFrame (BlockActionFrame.tsx / BlockActionFrame.module.css): one content block
//! with its title and a "more" menu at the end of the title row. The menu button shows while the
//! pointer is on this block and not on a block inside it (or while focus is inside it, or its
//! menu is open); a right click opens the same menu. An untitled block floats the button on its
//! top end corner, on a raised chip. The frame never clips, so the button keeps its focus ring.
use gpui::{
    AnyElement, App, ElementId, Entity, InteractiveElement as _, IntoElement, MouseButton,
    MouseMoveEvent, ParentElement, RenderOnce, SharedString, StatefulInteractiveElement as _,
    Styled as _, Window, div,
};

use super::overflow_action_menu::{OverflowActionMenu, OverflowItem};
use crate::tokens::{Color, Duration as DsDuration, Easing, Length, Shadow};
use crate::ui::context::Ds;
use crate::ui::convert;
use crate::ui::motion::{Props, Timing, Transition, transition};
use crate::ui::typo::{Typo, Weight};

/// `block`: a block on its own (section title). `child`: a block inside a container (a smaller title).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Level {
    #[default]
    Block,
    Child,
}

#[derive(IntoElement)]
pub struct BlockActionFrame {
    id: ElementId,
    title: Option<SharedString>,
    level: Level,
    actions: Vec<OverflowItem>,
    actions_label: SharedString,
    children: Vec<AnyElement>,
}

impl BlockActionFrame {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            title: None,
            level: Level::Block,
            actions: Vec::new(),
            actions_label: SharedString::default(),
            children: Vec::new(),
        }
    }

    /// The block's title; without one the button floats on the block's top end corner.
    pub fn title(mut self, title: impl Into<SharedString>) -> Self {
        self.title = Some(title.into());
        self
    }

    pub fn level(mut self, level: Level) -> Self {
        self.level = level;
        self
    }

    /// The block's actions; none makes a plain titled block.
    pub fn action(mut self, action: OverflowItem) -> Self {
        self.actions.push(action);
        self
    }

    /// The button's accessible name.
    pub fn actions_label(mut self, label: impl Into<SharedString>) -> Self {
        self.actions_label = label.into();
        self
    }
}

impl ParentElement for BlockActionFrame {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

/// The button's opacity: shown on this block's own hover, on focus inside it or while open.
fn reveal(shown: bool, id: &ElementId, window: &mut Window, cx: &mut App) -> (Transition, Timing) {
    let ds = Ds::get(cx);
    let timing = Timing::token(ds, DsDuration::MotionFast, Easing::MotionEaseStandard);
    let jump = ds.reduced_motion();
    let value = transition(
        (id.clone(), "trigger"),
        (f32::from(u8::from(shown)), jump),
        &timing,
        window,
        cx,
    );
    (value, timing)
}

/// Hover on the innermost block, and a right click that opens the menu.
fn gestures(
    frame: gpui::Stateful<gpui::Div>,
    hovered: &Entity<bool>,
    open: &Entity<bool>,
) -> gpui::Stateful<gpui::Div> {
    let (hover, closed) = (hovered.clone(), hovered.clone());
    let menu_open = open.clone();
    frame
        .on_mouse_move(move |_: &MouseMoveEvent, window, cx| {
            // Inner frames see the move first; the first claims it.
            let claimed = window.default_prevented();
            window.prevent_default();
            hover.update(cx, |on, cx| {
                if *on == claimed {
                    *on = !claimed;
                    cx.notify();
                }
            });
        })
        .on_hover(move |on, _, cx| {
            if !*on {
                closed.update(cx, |hovered, cx| {
                    *hovered = false;
                    cx.notify();
                });
            }
        })
        .on_mouse_down(MouseButton::Right, move |_, window, cx| {
            window.prevent_default();
            cx.stop_propagation();
            menu_open.update(cx, |open, cx| {
                *open = true;
                cx.notify();
            });
        })
}

/// The title row: the heading and the menu button (on a raised chip, floating on the corner,
/// when there is no title).
fn header(
    frame: &mut BlockActionFrame,
    (open, is_open): (&Entity<bool>, bool),
    (alpha, timing): (Transition, Timing),
    ds: &Ds,
) -> gpui::Div {
    let titled = frame.title.is_some();
    let heading = frame.title.take().map(|title| match frame.level {
        Level::Block => Typo::section_title(title).into_any_element(),
        Level::Child => Typo::label(title)
            .weight(Weight::Semibold)
            .into_any_element(),
    });
    let toggle = open.clone();
    let menu = OverflowActionMenu::new(
        SharedString::from(format!("{}-menu", frame.id)),
        frame.actions_label.clone(),
    )
    .open(is_open)
    .on_open_change(move |now, _, cx| {
        toggle.update(cx, |open, cx| {
            *open = now;
            cx.notify();
        });
    })
    .items(std::mem::take(&mut frame.actions));
    let mut trigger = alpha.apply(
        div().child(menu),
        &timing,
        &Props {
            opacity: Some((0., 1.)),
            ..Default::default()
        },
    );
    if !titled {
        trigger = trigger
            .rounded(ds.len(Length::RadiusPill))
            .bg(ds.color(Color::SurfaceRaised))
            .shadow(convert::box_shadows(
                ds.tokens().shadow(Shadow::ShadowControl),
                ds.tokens(),
            ));
    }
    let header = div()
        .flex()
        .min_w_0()
        .items_center()
        .justify_between()
        .gap(ds.len(Length::SpaceSm))
        .children(heading.map(|heading| div().min_w_0().child(heading)))
        .child(trigger);
    if titled {
        return header;
    }
    let edge = ds.len(Length::SpaceXs);
    header.absolute().top(edge).right(edge)
}

impl RenderOnce for BlockActionFrame {
    fn render(mut self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let id = self.id.clone();
        let hovered = window.use_keyed_state((id.clone(), "hover"), cx, |_, _| false);
        let open = window.use_keyed_state((id.clone(), "open"), cx, |_, _| false);
        let focus = window
            .use_keyed_state((id.clone(), "focus"), cx, |_, cx| cx.focus_handle())
            .read(cx)
            .clone();
        let has_actions = !self.actions.is_empty();
        let is_open = *open.read(cx);
        let shown = *hovered.read(cx) || is_open || focus.contains_focused(window, cx);
        let alpha = reveal(shown && has_actions, &id, window, cx);
        let ds = Ds::get(cx);
        let anchor = id.to_string();
        let mut frame = div()
            .id(id.clone())
            .debug_selector(move || anchor.clone())
            .relative()
            .flex()
            .flex_col()
            .min_w_0()
            .gap(ds.len(Length::SpaceSm))
            .track_focus(&focus);
        if has_actions {
            frame = gestures(frame, &hovered, &open);
        }
        if self.title.is_some() || has_actions {
            let header = header(&mut self, (&open, is_open), alpha, ds);
            if self.title.is_none() {
                // `z-index: var(--z-content)`: painted after the content, so over it.
                return frame.children(self.children).child(header);
            }
            frame = frame.child(header);
        }
        frame.children(self.children)
    }
}
