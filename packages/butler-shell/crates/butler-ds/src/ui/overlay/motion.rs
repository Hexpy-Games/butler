//! The enter and exit motion of an overlay surface, from the motion tokens: a fade, the travel
//! from the trigger's side and the keyframes' `scale` about the surface's transform origin (exit:
//! a fade and the scale, and for the mobile sheet a short travel back). Reduced motion zeroes the
//! travel and scale tokens and leaves the fade.
use gpui::{
    AnyElement, App, IntoElement as _, ParentElement as _, Styled as _, Window, div, point, px,
};

use super::lifecycle::Phase;
use super::place::Side;
use crate::tokens::{Duration as DsDuration, Easing, Length, Number};
use crate::ui::context::Ds;
use crate::ui::liquid_glass::{Presence, with_presence};
use crate::ui::motion::{Props, Timing, keyed};

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
    /// The scale the surface starts from (enter) and ends at (exit); none when it only fades.
    pub scale: Option<Number>,
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
        scale: Some(Number::MotionScaleMenu),
    };

    /// `popover-sheet-enter` / `-exit`: the attached mobile sheet travels 8px in and 4px out.
    pub const POPOVER_SHEET: Self = Self {
        enter_distance: Some(Length::MotionDistanceMd),
        exit_distance: Some(Length::MotionDistanceSm),
        scale: None,
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
        scale: Some(Number::MotionScaleMenu),
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
        scale: Some(Number::MotionScaleDialog),
    };

    /// `palette-enter` / `palette-exit`: only a scale.
    pub const PALETTE: Self = Self {
        enter: DsDuration::MotionPalette,
        enter_distance: None,
        scale: Some(Number::MotionScalePalette),
        ..Self::DIALOG
    };

    /// `palette-sheet-enter` / `-exit`: the phone palette drops in from `--motion-distance-lg`
    /// above and leaves back up (`Side::Bottom`).
    pub const PALETTE_SHEET: Self = Self {
        enter: DsDuration::MotionSlow,
        enter_ease: Easing::MotionEaseEmphasized,
        enter_distance: Some(Length::MotionDistanceLg),
        exit_distance: Some(Length::MotionDistanceLg),
        scale: None,
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

/// `content` with the enter or exit of `phase` on `side`, scaling about `origin` (fractions of
/// its box); nothing when closed.
pub fn animate(
    id: &str,
    phase: Phase,
    side: Side,
    origin: (f32, f32),
    motion: Motion,
    content: AnyElement,
    (window, cx): (&mut Window, &mut App),
) -> Option<AnyElement> {
    build(
        id,
        phase,
        (side, origin),
        motion,
        content,
        (window, cx, false),
    )
}

/// [`animate`] for a surface whose root is a TintedGlass: the progress is not an opacity but the
/// surface's presence, so the glass materializes and only its content fades (LG research §5
/// Appear/disappear, §8.1.6). Scale and travel are the same.
pub fn animate_glass(
    id: &str,
    phase: Phase,
    side: Side,
    origin: (f32, f32),
    motion: Motion,
    content: AnyElement,
    (window, cx): (&mut Window, &mut App),
) -> Option<AnyElement> {
    build(
        id,
        phase,
        (side, origin),
        motion,
        content,
        (window, cx, true),
    )
}

fn build(
    id: &str,
    phase: Phase,
    (side, origin): (Side, (f32, f32)),
    motion: Motion,
    content: AnyElement,
    (window, cx, glass): (&mut Window, &mut App, bool),
) -> Option<AnyElement> {
    let (key, entering) = match phase {
        Phase::Closed => return None,
        Phase::Open { key } => (key, true),
        Phase::Exiting { key, .. } => (key, false),
    };
    let ds = Ds::get(cx);
    let scale = motion.scale.map_or(1., |token| ds.number(token));
    let (duration, easing, distance) = if entering {
        (motion.enter, motion.enter_ease, motion.enter_distance)
    } else {
        (motion.exit, motion.exit_ease, motion.exit_distance)
    };
    let timing = Timing::token(ds, duration, easing);
    let (dx, dy) = from_trigger(side, distance.map_or(0., |d| f32::from(ds.len(d))));
    let enter_timing = Timing::token(ds, motion.enter, motion.enter_ease);
    let enter = keyed(format!("{id}-in-{key}"), 0., 1., &enter_timing, window, cx);
    let value = if entering {
        enter
    } else {
        keyed(
            format!("{id}-out-{key}"),
            enter.value(&enter_timing),
            0.,
            &timing,
            window,
            cx,
        )
    };
    let props = Props {
        opacity: (!glass).then_some((0., 1.)),
        offset: Some((point(px(dx), px(dy)), point(px(0.), px(0.)))),
        scale: Some((scale, 1.)),
        origin: Some(origin),
        ..Default::default()
    };
    let content = if glass {
        let presence = if value.moving(&timing) {
            Presence::Moving {
                from: value.from,
                to: value.to,
                start_ms: value.start_ms,
                timing,
            }
        } else {
            Presence::Static(value.target())
        };
        with_presence(presence, content).into_any_element()
    } else {
        content
    };
    Some(
        value
            .apply(div().relative().child(content), &timing, &props)
            .into_any_element(),
    )
}
