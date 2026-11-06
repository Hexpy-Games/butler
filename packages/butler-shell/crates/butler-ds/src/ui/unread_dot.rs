//! DS UnreadDot (UnreadDot.tsx / UnreadDot.module.css): a small accent dot for content the user
//! has not seen yet. It sits in an IconSlot one line tall, so it shares the trailing column of a
//! row's status marks. It fades in, fades out when read, and shows and hides at once under
//! reduced motion. It never pulses.
use std::rc::Rc;

use gpui::{
    App, ElementId, IntoElement, ParentElement as _, RenderOnce, SharedString, Styled as _, Window,
    div,
};

use super::context::Ds;
use super::icon_slot::{IconSlot, SlotSize};
use super::presence::{Presence, PresenceMotion};
use crate::tokens::Color;

type ExitCallback = Rc<dyn Fn(&mut App)>;

#[derive(IntoElement)]
pub struct UnreadDot {
    id: ElementId,
    label: SharedString,
    size: SlotSize,
    present: bool,
    on_exit_complete: Option<ExitCallback>,
}

impl UnreadDot {
    /// `label` is the accessible name, such as "Unread".
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            size: SlotSize::Sidebar,
            present: true,
            on_exit_complete: None,
        }
    }

    /// The accessible name (gpui draws none of it).
    pub fn aria_label(&self) -> &SharedString {
        &self.label
    }

    /// The icon column the dot sits in; `Sidebar` follows the sidebar density.
    pub fn size(mut self, size: SlotSize) -> Self {
        self.size = size;
        self
    }

    /// False fades the dot out, then drops it; true brings it in. Default true.
    pub fn present(mut self, present: bool) -> Self {
        self.present = present;
        self
    }

    /// Called once the dot has left after `present` turned false.
    pub fn on_exit_complete(mut self, callback: impl Fn(&mut App) + 'static) -> Self {
        self.on_exit_complete = Some(Rc::new(callback));
        self
    }
}

impl RenderOnce for UnreadDot {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        // Half the glyph column. // DS: UnreadDot.module.css:2
        let side = self.size.side(ds) * 0.5;
        // Reduced motion: no transition at all, the dot appears and goes at once.
        let motion = if ds.reduced_motion() {
            PresenceMotion::None
        } else {
            PresenceMotion::ScaleIn
        };
        let dot = div().size(side).rounded_full().bg(ds.color(Color::Accent));
        let mut presence = Presence::new((self.id, "presence"), self.present)
            .motion(motion)
            .child(IconSlot::new().size(self.size).min_line().child(dot));
        if let Some(callback) = self.on_exit_complete {
            presence = presence.on_exit_complete(move |cx| callback(cx));
        }
        presence
    }
}
