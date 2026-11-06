//! Presence (DS Presence.tsx): keeps a child mounted until its exit animation has ended.
//! Enter and exit run on motion tokens; reduced motion leaves a fade (the tokens zero the travel).
use std::rc::Rc;
use std::time::Duration;

use gpui::{
    AnyElement, App, ElementId, Entity, IntoElement, ParentElement as _, RenderOnce, SharedString,
    Styled as _, Window, div, px,
};

use super::context::Ds;
use super::motion::{Timing, Tween};
use crate::tokens::{Duration as DsDuration, Easing, Length, Number};

/// The built-in motion of a [`Presence`].
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PresenceMotion {
    None,
    Fade,
    /// Fades and scales from `--motion-scale-check`, in and out (Avatar's badge).
    Pop,
    /// Fades in while scaling up from 60%; leaves with a fade (UnreadDot).
    ScaleIn,
    #[default]
    Rise,
}

/// `transform: scale(0.6)` of UnreadDot's `@starting-style`.
const SCALE_IN_FROM: f32 = 0.6; // DS: UnreadDot.module.css:21

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Open,
    Exiting,
    Gone,
}

struct State {
    phase: Phase,
    /// Bumped on every change of `present`, so each enter and exit restarts its animation.
    generation: usize,
}

type ExitCallback = Rc<dyn Fn(&mut App)>;

#[derive(IntoElement)]
pub struct Presence {
    id: ElementId,
    present: bool,
    motion: PresenceMotion,
    child: Option<AnyElement>,
    on_exit_complete: Option<ExitCallback>,
}

impl Presence {
    pub fn new(id: impl Into<ElementId>, present: bool) -> Self {
        Self {
            id: id.into(),
            present,
            motion: PresenceMotion::default(),
            child: None,
            on_exit_complete: None,
        }
    }

    pub fn motion(mut self, motion: PresenceMotion) -> Self {
        self.motion = motion;
        self
    }

    pub fn child(mut self, child: impl IntoElement) -> Self {
        self.child = Some(child.into_any_element());
        self
    }

    pub fn on_exit_complete(mut self, callback: impl Fn(&mut App) + 'static) -> Self {
        self.on_exit_complete = Some(Rc::new(callback));
        self
    }
}

impl RenderOnce for Presence {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let exit = Ds::get(cx).duration(DsDuration::MotionExitBase);
        let initial = if self.present {
            Phase::Open
        } else {
            Phase::Gone
        };
        let state = window.use_keyed_state(self.id.clone(), cx, |_, _| State {
            phase: initial,
            generation: 0,
        });
        let (phase, generation) = state.update(cx, |state, _| {
            let animates = self.motion != PresenceMotion::None;
            match (self.present, state.phase) {
                (true, Phase::Open) | (false, Phase::Gone | Phase::Exiting) => {}
                (true, _) => {
                    state.phase = Phase::Open;
                    state.generation += 1;
                }
                (false, Phase::Open) => {
                    state.phase = if animates && !exit.is_zero() {
                        Phase::Exiting
                    } else {
                        Phase::Gone
                    };
                    state.generation += 1;
                }
            }
            (state.phase, state.generation)
        });
        if phase == Phase::Exiting {
            schedule_exit(
                &state,
                generation,
                exit,
                self.on_exit_complete.clone(),
                window,
                cx,
            );
        }
        let ds = Ds::get(cx);
        let Some(child) = self.child.filter(|_| phase != Phase::Gone) else {
            return div().into_any_element();
        };
        let id = ElementId::from(SharedString::from(format!("{}-{generation}", self.id)));
        match (phase, self.motion) {
            (_, PresenceMotion::None) => child,
            (phase, motion) => animated(id, (phase == Phase::Exiting, motion), child, ds),
        }
    }
}

/// `child` with the enter (rise and fade, scaling in for [`PresenceMotion::Pop`] and
/// [`PresenceMotion::ScaleIn`]) or, for `exiting`, the exit fade.
fn animated(
    id: ElementId,
    (exiting, motion): (bool, PresenceMotion),
    child: AnyElement,
    ds: &Ds,
) -> AnyElement {
    let pop = ds.number(Number::MotionScaleCheck);
    if exiting {
        let timing = Timing::token(ds, DsDuration::MotionExitBase, Easing::MotionEaseAccelerate);
        let to = if motion == PresenceMotion::Pop {
            pop
        } else {
            1.
        };
        return Tween::new(id, div().child(child), timing, move |el, t| {
            el.scale(1. - (1. - to) * t).opacity(1. - t)
        })
        .into_any_element();
    }
    let travel = match motion {
        PresenceMotion::Rise => f32::from(ds.len(Length::MotionDistanceSm)),
        _ => 0.,
    };
    let timing = Timing::token(ds, DsDuration::MotionBase, Easing::MotionEaseDecelerate);
    let from = match motion {
        PresenceMotion::Pop => pop,
        PresenceMotion::ScaleIn => SCALE_IN_FROM,
        _ => 1.,
    };
    Tween::new(id, div().relative().child(child), timing, move |el, t| {
        el.top(px(travel * (1. - t)))
            .scale(from + (1. - from) * t)
            .opacity(t)
    })
    .into_any_element()
}

/// Unmounts the child once the exit has run, unless `present` changed meanwhile.
fn schedule_exit(
    state: &Entity<State>,
    generation: usize,
    exit: Duration,
    callback: Option<ExitCallback>,
    window: &mut Window,
    cx: &mut App,
) {
    let entity = state.clone();
    window
        .spawn(cx, async move |cx| {
            cx.background_executor().timer(exit).await;
            cx.update(|_, cx| {
                let ended = entity.update(cx, |state, cx| {
                    let ended = state.phase == Phase::Exiting && state.generation == generation;
                    if ended {
                        state.phase = Phase::Gone;
                        cx.notify();
                    }
                    ended
                });
                if let (true, Some(callback)) = (ended, callback) {
                    callback(cx);
                }
            })
            .ok();
        })
        .detach();
}
