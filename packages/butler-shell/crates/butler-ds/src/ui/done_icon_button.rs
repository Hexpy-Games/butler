//! DS DoneIconButton (DoneIconButton.tsx): an icon button whose icon turns into a drawn check
//! once its action succeeds, then returns after `DONE_FEEDBACK_MS`. An action that is still
//! running ignores further clicks; a failed one shows no check.
use std::rc::Rc;
use std::time::Duration;

use gpui::{
    AnyElement, App, ElementId, Entity, IntoElement, ParentElement as _, RenderOnce, SharedString,
    Styled as _, Task, Window, div,
};

use super::context::Ds;
use super::icon_button::IconButton;
use super::motion::{Props, Timing, keyed};
use super::success_check::SuccessCheck;
use crate::tokens::{Color, Duration as DsDuration, Easing, Length, Number};

/// How long the check stays before the action icon returns (`DONE_FEEDBACK_MS`).
pub const DONE_FEEDBACK: Duration = Duration::from_millis(1500); // DS: DoneIconButton.tsx:10

/// What the action reports: success shows the check, an error goes to `on_error`.
pub type Outcome = Result<(), SharedString>;
type Action = Rc<dyn Fn(&mut Window, &mut App) -> Task<Outcome>>;
type ErrorHandler = Rc<dyn Fn(&SharedString, &mut App)>;

#[derive(Default)]
struct State {
    done: bool,
    pending: bool,
    /// Bumped by every revert timer start, so only the last one clears `done`.
    generation: usize,
    /// Each false-to-true change mounts a new check.
    check_run: usize,
    was_done: bool,
    /// The done state changed since mount (before that nothing animates).
    flips: usize,
}

#[derive(IntoElement)]
pub struct DoneIconButton {
    id: ElementId,
    label: SharedString,
    done_label: SharedString,
    icon: Option<AnyElement>,
    action: Option<Action>,
    done: Option<bool>,
    on_error: Option<ErrorHandler>,
}

impl DoneIconButton {
    pub fn new(
        id: impl Into<ElementId>,
        label: impl Into<SharedString>,
        done_label: impl Into<SharedString>,
    ) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            done_label: done_label.into(),
            icon: None,
            action: None,
            done: None,
            on_error: None,
        }
    }

    /// The action's icon at `sm`; it fades to a check on success.
    pub fn icon(mut self, icon: impl IntoElement) -> Self {
        self.icon = Some(icon.into_any_element());
        self
    }

    /// Runs on click; the check shows once the task resolves.
    pub fn on_action(
        mut self,
        action: impl Fn(&mut Window, &mut App) -> Task<Outcome> + 'static,
    ) -> Self {
        self.action = Some(Rc::new(action));
        self
    }

    /// Parent-driven done state; overrides the internal feedback state.
    pub fn done(mut self, done: bool) -> Self {
        self.done = Some(done);
        self
    }

    pub fn on_error(mut self, handler: impl Fn(&SharedString, &mut App) + 'static) -> Self {
        self.on_error = Some(Rc::new(handler));
        self
    }
}

/// Runs the action and, on success, shows the check for `DONE_FEEDBACK`.
fn run(
    state: &Entity<State>,
    action: &Action,
    on_error: Option<ErrorHandler>,
    window: &mut Window,
    cx: &mut App,
) {
    if state.update(cx, |s, _| std::mem::replace(&mut s.pending, true)) {
        return;
    }
    let task = action(window, cx);
    let state = state.clone();
    window
        .spawn(cx, async move |cx| {
            let outcome = task.await;
            cx.update(|_, cx| finish(&state, outcome, on_error, cx))
                .ok();
        })
        .detach();
}

fn finish(state: &Entity<State>, outcome: Outcome, on_error: Option<ErrorHandler>, cx: &mut App) {
    match outcome {
        Ok(()) => {
            let generation = state.update(cx, |s, cx| {
                s.pending = false;
                s.done = true;
                s.generation += 1;
                cx.notify();
                s.generation
            });
            let state = state.clone();
            cx.spawn(async move |cx| {
                cx.background_executor().timer(DONE_FEEDBACK).await;
                cx.update(|cx| {
                    state.update(cx, |s, cx| {
                        if s.generation == generation {
                            s.done = false;
                            cx.notify();
                        }
                    });
                });
            })
            .detach();
        }
        Err(error) => {
            state.update(cx, |s, cx| {
                s.pending = false;
                cx.notify();
            });
            if let Some(handler) = on_error {
                handler(&error, cx);
            }
        }
    }
}

impl DoneIconButton {
    /// The action icon and the check share one cell and crossfade over `--motion-fast`.
    fn glyphs(
        &mut self,
        state: &Entity<State>,
        done: bool,
        window: &mut Window,
        cx: &mut App,
    ) -> AnyElement {
        let ds = Ds::get(cx);
        let (run, flips) = {
            let s = state.read(cx);
            (s.check_run, s.flips)
        };
        let side = ds.len(Length::IconSizeSm);
        let cell = move |content: AnyElement| {
            div()
                .absolute()
                .top_0()
                .left_0()
                .size(side)
                .flex()
                .items_center()
                .justify_center()
                .child(content)
        };
        let check = SuccessCheck::new((self.id.clone(), format!("check-{run}")))
            .size(f32::from(side))
            .animate_if(run > 0);
        let action = self.icon.take().map(IntoElement::into_any_element);
        let timing = Timing::token(ds, DsDuration::MotionFast, Easing::MotionEaseStandard);
        let check_color = ds.color(Color::TextPrimary);
        // DS: DoneIconButton.module.css:20,25 `transform: scale(var(--motion-scale-menu))`.
        let shrink = 1. - ds.number(Number::MotionScaleMenu);
        let id = (self.id.clone(), format!("morph-{flips}"));
        let (from, to) = if done { (0., 1.) } else { (1., 0.) };
        let value = if flips == 0 {
            super::motion::transition(id, (1., true), &timing, window, cx)
        } else {
            keyed(id, 0., 1., &timing, window, cx)
        };
        let action = cell(action.unwrap_or_else(|| div().into_any_element()));
        let check = cell(check.into_any_element()).text_color(check_color);
        div()
            .relative()
            .size(side)
            .child(value.apply(
                action,
                &timing,
                &Props {
                    opacity: Some((1. - from, 1. - to)),
                    scale: Some((1. - shrink * from, 1. - shrink * to)),
                    ..Default::default()
                },
            ))
            .child(value.apply(
                check,
                &timing,
                &Props {
                    opacity: Some((from, to)),
                    scale: Some((1. - shrink * (1. - from), 1. - shrink * (1. - to))),
                    ..Default::default()
                },
            ))
            .into_any_element()
    }
}

impl RenderOnce for DoneIconButton {
    fn render(mut self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let state = window.use_keyed_state((self.id.clone(), "done"), cx, |_, _| State::default());
        let done = self.done.unwrap_or_else(|| state.read(cx).done);
        state.update(cx, |s, _| {
            if done != s.was_done {
                s.was_done = done;
                s.flips += 1;
                if done {
                    s.check_run += 1;
                }
            }
        });
        let glyphs = self.glyphs(&state, done, window, cx);
        let label = if done {
            self.done_label.clone()
        } else {
            self.label.clone()
        };
        let (action, on_error) = (self.action.clone(), self.on_error.clone());
        let handler_state = state.clone();
        let mut button = IconButton::new((self.id.clone(), "button"), label).icon(glyphs);
        if let Some(action) = action {
            button = button.on_click(move |_, window, cx| {
                run(&handler_state, &action, on_error.clone(), window, cx);
            });
        }
        button
    }
}
