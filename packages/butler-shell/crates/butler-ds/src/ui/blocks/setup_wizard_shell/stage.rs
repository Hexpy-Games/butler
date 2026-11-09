//! SetupWizardStage (SetupWizardStage.tsx, `.stage*` of SetupWizardShell.module.css): replaces
//! the focus column when `step_key` changes. The old card (`leaving`, the caller's previous
//! step) fades out over `--motion-exit-base` on the accelerate curve while the new card rises in
//! 4px over `--motion-base`; `intro` gives the first card the re-run entrance (`--motion-slow`).
//! Under reduced motion cards swap at once. Not reproduced: the card morph (one surface moving
//! its real edges between two solid cards) and the first-install ink intro (P6).

use gpui::{
    AnyElement, App, ElementId, IntoElement, ParentElement, RenderOnce, SharedString, Styled as _,
    Window, div, px,
};

use crate::tokens::{Duration as DsDuration, Easing, Length};
use crate::ui::context::Ds;
use crate::ui::motion::{self, Props, Timing, Transition};

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
    since: u32,
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

impl RenderOnce for SetupWizardStage {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let motion = !ds.reduced_motion();
        let rise = ds.len(Length::MotionDistanceSm);
        let gap = ds.len(Length::SpaceLg);
        let step = Timing::token(ds, DsDuration::MotionBase, Easing::MotionEaseDecelerate);
        let rerun = Timing::token(ds, DsDuration::MotionSlow, Easing::MotionEaseDecelerate);
        let exit = Timing::token(ds, DsDuration::MotionExitBase, Easing::MotionEaseAccelerate);
        let now = gpui::animation_time_ms();
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
        let timing = if enter == Some(Enter::Step) {
            step
        } else {
            rerun
        };
        let entrance = Transition {
            from: 0.,
            to: 1.,
            start_ms: since,
        };
        let leave = Transition {
            from: 1.,
            to: 0.,
            ..entrance
        };
        let ghost = self
            .leaving
            .filter(|_| enter == Some(Enter::Step) && leave.moving(&exit));
        if ghost.is_some() {
            let elapsed = std::time::Duration::from_millis(u64::from(now.wrapping_sub(since)));
            motion::wake_after(window, cx, exit.duration.saturating_sub(elapsed));
        }
        let column = || div().w_full().flex().flex_col().items_center().gap(gap);
        let ghost = ghost.map(|old| {
            leave.apply(
                column().absolute().top_0().left_0().child(old),
                &exit,
                &Props {
                    opacity: Some((0., 1.)),
                    ..Default::default()
                },
            )
        });
        let current = column().children(self.children);
        let current = if self.held {
            current.opacity(0.)
        } else if enter.is_some() {
            entrance.apply(
                current,
                &timing,
                &Props {
                    opacity: Some((0., 1.)),
                    offset: Some((gpui::point(px(0.), rise), gpui::point(px(0.), px(0.)))),
                    ..Default::default()
                },
            )
        } else {
            current
        };
        div().relative().w_full().children(ghost).child(current)
    }
}
