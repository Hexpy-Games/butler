//! The drag physics of a sheet (BottomSheet `sheetBehavior.ts`, `useSheetDrag`). The constants
//! are load-bearing: a release is a dismiss, a detent change or a spring back by distance and by
//! the speed of the last pointer move.
use std::time::Instant;

/// Share of the sheet's height a drag must travel down to dismiss it.
const DISMISS_SHARE: f32 = 0.3; // DS: sheetBehavior.ts:4
/// px/ms: a flick this fast dismisses (down) or expands (up) whatever the distance.
const FLICK_VELOCITY: f32 = 0.5; // DS: sheetBehavior.ts:6
/// px: travel that turns a press into a drag (the grabber's tap then does nothing).
const DRAG_SLOP: f32 = 4.; // DS: sheetBehavior.ts:8
/// px: travel that changes the detent of an expandable sheet.
const EXPAND_DISTANCE: f32 = 48.; // DS: sheetBehavior.ts:10
/// An expanded sheet collapses only when the drag is shorter than this share of its height.
const COLLAPSE_BELOW: f32 = 0.6; // DS: sheetBehavior.ts:55
/// Past the top of a sheet that cannot expand, the sheet follows the pointer at this fraction.
const RESISTANCE: f32 = 4.; // DS: sheetBehavior.ts:96

/// The detent state a drag works against.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct Detent {
    pub(super) expandable: bool,
    pub(super) expanded: bool,
}

/// What a release does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Outcome {
    /// An expanded sheet drops back to its resting height.
    Collapse,
    /// The sheet closes, its exit starting from the offset it was dragged to.
    Dismiss,
    /// An expandable sheet grows to its full height.
    Expand,
    /// The sheet settles back to rest.
    SpringBack,
}

/// One pointer drag: where it began, where the pointer last was and how fast it was moving.
#[derive(Clone, Copy, Debug)]
pub(super) struct Drag {
    start_y: f32,
    last_y: f32,
    last_at: Instant,
    /// px/ms, of the last pointer move only (as the pointer events report it).
    velocity: f32,
    /// The sheet's height when the press began.
    height: f32,
    moved: bool,
}

impl Drag {
    pub(super) fn begin(y: f32, at: Instant, height: f32) -> Self {
        Self {
            start_y: y,
            last_y: y,
            last_at: at,
            velocity: 0.,
            height,
            moved: false,
        }
    }

    /// A pointer move to `y`: the offset the sheet takes. Down it follows the pointer 1:1; up it
    /// follows only while it can still expand, else with resistance.
    pub(super) fn follow(&mut self, y: f32, at: Instant, detent: Detent) -> f32 {
        let elapsed = at.saturating_duration_since(self.last_at).as_secs_f32() * 1000.;
        self.velocity = (y - self.last_y) / elapsed.max(1.);
        self.last_y = y;
        self.last_at = at;
        let distance = y - self.start_y;
        if distance.abs() > DRAG_SLOP {
            self.moved = true;
        }
        if distance >= 0. || (detent.expandable && !detent.expanded) {
            distance
        } else {
            distance / RESISTANCE
        }
    }

    /// Whether the pointer travelled past the slop: the press must not also click the grabber.
    pub(super) fn moved(&self) -> bool {
        self.moved
    }

    /// The pointer lets go at `y`. In priority order: collapse an expanded sheet dragged down a
    /// little, dismiss on a long drag or a down flick, expand on a long drag up or an up flick,
    /// else spring back.
    pub(super) fn release(&self, y: f32, detent: Detent) -> Outcome {
        let distance = y - self.start_y;
        let flick_down = self.velocity > FLICK_VELOCITY && distance > DRAG_SLOP;
        let flick_up = self.velocity < -FLICK_VELOCITY && distance < -DRAG_SLOP;
        if detent.expandable
            && detent.expanded
            && !flick_down
            && distance > EXPAND_DISTANCE
            && distance < self.height * COLLAPSE_BELOW
        {
            Outcome::Collapse
        } else if distance > self.height * DISMISS_SHARE || flick_down {
            Outcome::Dismiss
        } else if detent.expandable && !detent.expanded && (distance < -EXPAND_DISTANCE || flick_up)
        {
            Outcome::Expand
        } else {
            Outcome::SpringBack
        }
    }
}
