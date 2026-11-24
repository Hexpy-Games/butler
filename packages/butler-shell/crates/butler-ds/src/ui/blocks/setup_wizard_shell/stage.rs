//! SetupWizardStage (SetupWizardStage.tsx, `.stage*` of SetupWizardShell.module.css): replaces
//! the focus column when `step_key` changes. The old card (`leaving`, the caller's previous
//! step) fades out over `--motion-exit-base` on the accelerate curve while the new card rises in
//! 4px over `--motion-base`; `intro` gives the first card the re-run entrance (`--motion-slow`).
//! Between solid cards, one surface moves its edges and the new rows arrive in order. Under
//! reduced motion cards swap at once. The old content drops away during a morph, and the larger
//! card has no content clip: its rows are invisible until the surface has nearly arrived. The
//! first-install ink intro is still pending (P6).
//! A step card's header stays visible through a morph when the previous card had a header,
//! and otherwise arrives as the first row. This is a 2026-11-24 owner decision that differs
//! from Electron, where the header staggers with the rows.

use std::{cell::Cell, rc::Rc};

use gpui::{
    AnyElement, App, ElementId, InteractiveElement as _, IntoElement, ParentElement, RenderOnce,
    SharedString, Styled as _, Window, div, px,
};

use crate::tokens::{Duration as DsDuration, Easing, Length};
use crate::ui::context::Ds;
use crate::ui::motion::{self, Props, Timing, Transition};

/// What a stage tells the cards built for it: when the card morph that is running began. The
/// caller keeps one per stage and hands it to the shell ([`super::SetupWizardShell::morph`]) and
/// to the card that owns the rows (`SetupWizardContent::rows`, `SetupWizardStepCard::rows`).
#[derive(Clone, Default)]
pub struct SetupWizardMorph(Rc<MorphState>);

#[derive(Default)]
struct MorphState {
    since: Cell<Option<u32>>,
    header: Cell<bool>,
    kept_header: Cell<bool>,
}

impl SetupWizardMorph {
    pub fn new() -> Self {
        Self::default()
    }

    /// The clock value at which the last step change began a morph; none after a plain swap.
    pub(in crate::ui::blocks) fn since(&self) -> Option<u32> {
        self.0.since.get()
    }

    pub(in crate::ui::blocks) fn set_header(&self, shown: bool) {
        self.0.header.set(shown);
    }

    pub(in crate::ui::blocks) fn keeps_header(&self) -> bool {
        self.0.kept_header.get()
    }
}

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
    solid: bool,
    morph: bool,
}

#[derive(IntoElement)]
pub struct SetupWizardStage {
    id: ElementId,
    step_key: SharedString,
    intro: Option<SetupWizardIntro>,
    held: bool,
    leaving: Option<AnyElement>,
    morph: Option<(SetupWizardMorph, bool)>,
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
            morph: None,
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

    /// The stage's morph handle and whether this step's card is solid; see
    /// [`super::SetupWizardShell::morph`].
    pub fn morph(mut self, morph: Option<(SetupWizardMorph, bool)>) -> Self {
        self.morph = morph;
        self
    }

    fn update_state(
        &self,
        now: u32,
        motion: bool,
        deliberate: &Timing,
        window: &mut Window,
        cx: &mut App,
    ) -> (Option<Enter>, u32, bool) {
        let handle = self.morph.as_ref().map(|(handle, _)| handle);
        let solid_now = self.morph.as_ref().is_some_and(|(_, solid)| *solid);
        let first = (motion && self.intro.is_some() && !self.held).then_some(Enter::Rerun);
        let state = window.use_keyed_state((self.id.clone(), "stage"), cx, |_, _| StageState {
            key: self.step_key.clone(),
            since: now,
            enter: first,
            was_held: self.held,
            solid: solid_now,
            morph: false,
        });
        state.update(cx, |state, _| {
            if state.key != self.step_key {
                let morph = motion && state.solid && solid_now && handle.is_some();
                state.key = self.step_key.clone();
                state.since = now;
                state.enter = motion.then_some(Enter::Step);
                state.morph = morph;
                if let Some(handle) = handle {
                    handle.0.since.set(morph.then_some(now));
                    handle.0.kept_header.set(morph && handle.0.header.get());
                    handle.0.header.set(false);
                }
                if morph {
                    window.animate_layout(deliberate.ms());
                }
            } else if state.was_held && !self.held {
                state.since = now;
                state.enter = (motion && self.intro.is_some()).then_some(Enter::Rerun);
            }
            state.was_held = self.held;
            state.solid = solid_now;
            (state.enter, state.since, state.morph)
        })
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
        let deliberate = Timing::token(
            ds,
            DsDuration::MotionDeliberate,
            Easing::MotionEaseEmphasized,
        );
        let now = gpui::animation_time_ms();
        let (enter, since, morph) = self.update_state(now, motion, &deliberate, window, cx);
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
            .filter(|_| enter == Some(Enter::Step) && !morph && leave.moving(&exit));
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
        } else if enter == Some(Enter::Rerun) || (enter == Some(Enter::Step) && !morph) {
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
        let cover =
            (morph && enter == Some(Enter::Step) && entrance.moving(&deliberate)).then(|| {
                motion::wake_after(window, cx, entrance.remaining(&deliberate));
                div().absolute().inset_0().occlude()
            });
        div()
            .relative()
            .w_full()
            .children(ghost)
            .child(current)
            .children(cover)
    }
}
