//! The enter and exit motion of an overlay surface, from the motion tokens. gpui has no element
//! transform, so the `scale` of the CSS keyframes is not drawn: enter is a fade plus the travel
//! from the trigger's side, exit a fade (and, for the mobile sheet, a short travel back).
//! Reduced motion zeroes the travel tokens and leaves the fade.
use gpui::{AnyElement, IntoElement as _, ParentElement as _, Styled as _, div, px};

use super::lifecycle::Phase;
use super::place::Side;
use crate::tokens::{Duration as DsDuration, Easing, Length};
use crate::ui::context::Ds;
use crate::ui::motion::{Timing, Tween};

/// One overlay family's keyframes.
#[derive(Clone, Copy, Debug)]
pub struct Motion {
    pub enter: DsDuration,
    pub enter_ease: Easing,
    /// How far the surface travels in from its trigger's side; none when it only scales.
    pub enter_distance: Option<Length>,
    pub exit: DsDuration,
    pub exit_ease: Easing,
    /// How far the surface travels back toward its trigger while it exits.
    pub exit_distance: Option<Length>,
}

impl Motion {
    /// `popover-enter` / `popover-exit` (Popover.module.css).
    pub const POPOVER: Self = Self {
        enter: DsDuration::MotionEnterOverlay,
        enter_ease: Easing::MotionEaseEnter,
        enter_distance: Some(Length::MotionDistanceSm),
        exit: DsDuration::MotionExitFast,
        exit_ease: Easing::MotionEaseAccelerate,
        exit_distance: None,
    };

    /// `popover-sheet-enter` / `-exit`: the attached mobile sheet travels 8px in and 4px out.
    pub const POPOVER_SHEET: Self = Self {
        enter_distance: Some(Length::MotionDistanceMd),
        exit_distance: Some(Length::MotionDistanceSm),
        ..Self::POPOVER
    };

    /// `menu-enter` / `menu-exit` (DropdownMenu and ContextMenu).
    pub const MENU: Self = Self {
        enter: DsDuration::MotionEnterMenu,
        enter_ease: Easing::MotionEaseEnter,
        enter_distance: Some(Length::MotionDistanceXs),
        exit: DsDuration::MotionExitMenu,
        exit_ease: Easing::MotionEaseAccelerate,
        exit_distance: None,
    };
}

impl Motion {
    /// `dialog-enter` / `dialog-exit` (Dialog.module.css): in from 4px below the centre. `side`
    /// is `Side::Top`, the side the surface starts away from.
    pub const DIALOG: Self = Self {
        enter: DsDuration::MotionBase,
        enter_ease: Easing::MotionEaseStandard,
        enter_distance: Some(Length::MotionDistanceSm),
        exit: DsDuration::MotionExitFast,
        exit_ease: Easing::MotionEaseAccelerate,
        exit_distance: None,
    };

    /// `palette-enter` / `palette-exit`: only a scale (not drawn), so a fade.
    pub const PALETTE: Self = Self {
        enter: DsDuration::MotionPalette,
        enter_distance: None,
        ..Self::DIALOG
    };

    /// `palette-sheet-enter` / `-exit`: the phone palette drops in from `--motion-distance-lg`
    /// above and leaves back up (`Side::Bottom`).
    pub const PALETTE_SHEET: Self = Self {
        enter: DsDuration::MotionSlow,
        enter_ease: Easing::MotionEaseEmphasized,
        enter_distance: Some(Length::MotionDistanceLg),
        exit_distance: Some(Length::MotionDistanceLg),
        ..Self::DIALOG
    };
}

/// Where a surface on `side` of its trigger starts, relative to its place: toward the trigger
/// by `distance` along the side's axis.
fn from_trigger(side: Side, distance: f32) -> (f32, f32) {
    match side {
        Side::Top => (0., distance),
        Side::Bottom => (0., -distance),
        Side::Left => (distance, 0.),
        Side::Right => (-distance, 0.),
    }
}

/// `content` with the enter or exit of `phase` on `side`; nothing when closed.
pub fn animate(
    id: &str,
    phase: Phase,
    side: Side,
    motion: Motion,
    content: AnyElement,
    ds: &Ds,
) -> Option<AnyElement> {
    match phase {
        Phase::Closed => None,
        Phase::Open { key } => {
            let timing = Timing::token(ds, motion.enter, motion.enter_ease);
            let distance = motion.enter_distance.map_or(0., |d| f32::from(ds.len(d)));
            let (dx, dy) = from_trigger(side, distance);
            Some(
                Tween::new(
                    format!("{id}-in-{key}"),
                    div().relative().child(content),
                    timing,
                    move |el, t| el.left(px(dx * (1. - t))).top(px(dy * (1. - t))).opacity(t),
                )
                .into_any_element(),
            )
        }
        Phase::Exiting { key, .. } => {
            let timing = Timing::token(ds, motion.exit, motion.exit_ease);
            let (dx, dy) = motion
                .exit_distance
                .map_or((0., 0.), |d| from_trigger(side, f32::from(ds.len(d))));
            Some(
                Tween::new(
                    format!("{id}-out-{key}"),
                    div().relative().child(content),
                    timing,
                    move |el, t| el.left(px(dx * t)).top(px(dy * t)).opacity(1. - t),
                )
                .into_any_element(),
            )
        }
    }
}
