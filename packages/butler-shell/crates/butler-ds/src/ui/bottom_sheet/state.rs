//! A sheet's runtime state, kept across frames: the detent, the drag in progress and the offset
//! the surface is at (`--sheet-drag-y`), which eases back to rest after a release that does not
//! dismiss (`transition: transform var(--motion-slow) var(--motion-ease-settle)`).
use std::time::Instant;

use super::drag::{Detent, Drag, Outcome};
use crate::tokens::{Duration as DsDuration, Easing};
use crate::ui::context::Ds;
use crate::ui::convert;
use crate::ui::motion::Ramp;
use crate::ui::overlay::popper::Anchor;

/// The state of one sheet (a BottomSheet or a presented overlay).
#[derive(Default)]
pub struct SheetState {
    /// Changes with every open: each open starts at rest, collapsed.
    key: usize,
    expanded: bool,
    expandable: bool,
    drag: Option<Drag>,
    /// A press that became a drag must not also click the grabber.
    moved: bool,
    /// `--sheet-drag-y`: set directly while a finger moves the sheet, eased otherwise.
    offset: Ramp,
    /// The surface's measured box: `translateY(100%)` is its height.
    pub(super) surface: Anchor,
}

impl SheetState {
    /// Starts an open: back at rest and collapsed.
    pub(super) fn open(&mut self, key: usize) {
        if self.key != key {
            *self = Self {
                key,
                surface: self.surface.clone(),
                ..Self::default()
            };
        }
    }

    pub(super) fn set_expandable(&mut self, expandable: bool) {
        self.expandable = expandable;
    }

    pub(super) fn expanded(&self) -> bool {
        self.expandable && self.expanded
    }

    pub(super) fn dragging(&self) -> bool {
        self.drag.is_some()
    }

    fn detent(&self) -> Detent {
        Detent {
            expandable: self.expandable,
            expanded: self.expanded,
        }
    }

    /// The pointer goes down on the handle row; `height` is the sheet's.
    pub(super) fn press(&mut self, y: f32, at: Instant, height: f32) {
        self.moved = false;
        self.drag = Some(Drag::begin(y, at, height));
    }

    /// The pointer moves while pressed: the sheet follows it.
    pub(super) fn follow(&mut self, y: f32, at: Instant) {
        let detent = self.detent();
        let Some(drag) = self.drag.as_mut() else {
            return;
        };
        let offset = drag.follow(y, at, detent);
        self.moved |= drag.moved();
        self.offset.retarget(offset, at, true);
    }

    /// The pointer lets go. A dismiss keeps the offset (the exit starts from it); any other
    /// outcome lets it settle back to rest. The caller closes the sheet on `Dismiss`.
    pub(super) fn release(&mut self, y: f32, at: Instant) -> Option<Outcome> {
        let drag = self.drag.take()?;
        let outcome = drag.release(y, self.detent());
        match outcome {
            Outcome::Dismiss => {}
            Outcome::Collapse => {
                self.expanded = false;
                self.offset.retarget(0., at, false);
            }
            Outcome::Expand => {
                self.expanded = true;
                self.offset.retarget(0., at, false);
            }
            Outcome::SpringBack => self.offset.retarget(0., at, false),
        }
        Some(outcome)
    }

    /// Consumes the "a drag moved" flag: true when a click is the end of a drag.
    pub(super) fn take_moved(&mut self) -> bool {
        std::mem::take(&mut self.moved)
    }

    /// The offset now, and whether it is still easing.
    pub(super) fn offset(&mut self, now: Instant, ds: &Ds) -> (f32, bool) {
        let ease = convert::easing(ds.tokens().ease(Easing::MotionEaseSettle));
        self.offset
            .sample(now, ds.duration(DsDuration::MotionSlow), &ease)
    }

    /// The offset the sheet was last at: the exit starts from it.
    pub(super) fn held_offset(&self) -> f32 {
        self.offset.target()
    }
}
