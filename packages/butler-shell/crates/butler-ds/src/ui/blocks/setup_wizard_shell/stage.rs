//! SetupWizardStage (SetupWizardStage.tsx, `.stage*` of SetupWizardShell.module.css): replaces
//! the focus column when `step_key` changes. The old card (`leaving`, the caller's previous
//! step) fades out over `--motion-exit-base` on the accelerate curve while the new card rises in
//! 4px over `--motion-base`; `intro` gives the first card the re-run entrance (`--motion-slow`).
//! Under reduced motion cards swap at once. Not reproduced: the card morph (one surface moving
//! its real edges between two solid cards) and the first-install ink intro (P6).
use std::time::Instant;

use gpui::{
    AnyElement, App, ElementId, IntoElement, ParentElement, RenderOnce, SharedString, Styled as _,
    Window, div, px,
};

use crate::tokens::{Duration as DsDuration, Easing, Length};
use crate::ui::context::Ds;
use crate::ui::motion::Timing;

/// How the first card appears. `Full` is the ink intro, which the wallpaper engine draws; here
/// it shares the re-run entrance. `None` has no ink: the card has the re-run entrance.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SetupWizardIntro {
    None,
    Rerun,
    Full,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Enter {
    Step,
    Rerun,
}

struct StageState {
    key: SharedString,
    since: Instant,
    enter: Option<Enter>,
    was_held: bool,
}

#[derive(IntoElement)]
pub struct SetupWizardStage {
    id: ElementId,
    step_key: SharedString,
    intro: Option<SetupWizardIntro>,
    held: bool,
    leaving: Option<AnyElement>,
    children: Vec<AnyElement>,
}

impl SetupWizardStage {
    pub fn new(id: impl Into<ElementId>, step_key: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            step_key: step_key.into(),
            intro: None,
            held: false,
            leaving: None,
            children: Vec::new(),
        }
    }

    pub fn intro(mut self, intro: Option<SetupWizardIntro>) -> Self {
        self.intro = intro;
        self
    }

    /// The card waits unseen until the host can show the intro; it arrives when the hold ends.
    pub fn held(mut self, held: bool) -> Self {
        self.held = held;
        self
    }

    /// The previous step's card; it fades out while the new key's card arrives.
    pub fn leaving(mut self, leaving: Option<AnyElement>) -> Self {
        self.leaving = leaving;
        self
    }
}

impl ParentElement for SetupWizardStage {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

/// Linear progress of `timing` after `elapsed` seconds, clamped to 0..=1.
fn progress(timing: &Timing, elapsed: f32) -> f32 {
    let total = timing.duration.as_secs_f32();
    if total <= 0. {
        1.
    } else {
        (elapsed / total).min(1.)
    }
}

impl RenderOnce for SetupWizardStage {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let motion = !ds.reduced_motion();
        let (rise, gap) = (
            f32::from(ds.len(Length::MotionDistanceSm)),
            ds.len(Length::SpaceLg),
        );
        let step = Timing::token(ds, DsDuration::MotionBase, Easing::MotionEaseDecelerate);
        let rerun = Timing::token(ds, DsDuration::MotionSlow, Easing::MotionEaseDecelerate);
        let exit = Timing::token(ds, DsDuration::MotionExitBase, Easing::MotionEaseAccelerate);
        let now = cx.background_executor().now();
        let first = (motion && self.intro.is_some() && !self.held).then_some(Enter::Rerun);
        let state = window.use_keyed_state((self.id.clone(), "stage"), cx, |_, _| StageState {
            key: self.step_key.clone(),
            since: now,
            enter: first,
            was_held: self.held,
        });
        let (enter, since) = state.update(cx, |state, _| {
            if state.key != self.step_key {
                state.key = self.step_key.clone();
                state.since = now;
                state.enter = motion.then_some(Enter::Step);
            } else if state.was_held && !self.held {
                state.since = now;
                state.enter = (motion && self.intro.is_some()).then_some(Enter::Rerun);
            }
            state.was_held = self.held;
            (state.enter, state.since)
        });
        let elapsed = now.saturating_duration_since(since).as_secs_f32();
        let (shown, entering) = match enter {
            Some(kind) => {
                let timing = if kind == Enter::Step { &step } else { &rerun };
                let raw = progress(timing, elapsed);
                (timing.ease(raw), raw < 1.)
            }
            None => (1., false),
        };
        let leave = progress(&exit, elapsed);
        let ghost = self
            .leaving
            .filter(|_| enter == Some(Enter::Step) && leave < 1.);
        if entering || ghost.is_some() {
            window.request_animation_frame();
        }
        let alpha = if self.held { 0. } else { shown };
        let column = || div().w_full().flex().flex_col().items_center().gap(gap);
        let ghost = ghost.map(|old| {
            column()
                .absolute()
                .top_0()
                .left_0()
                .opacity(1. - exit.ease(leave))
                .child(old)
        });
        div().relative().w_full().children(ghost).child(
            column()
                .relative()
                .top(px(rise * (1. - shown)))
                .opacity(alpha)
                .children(self.children),
        )
    }
}
