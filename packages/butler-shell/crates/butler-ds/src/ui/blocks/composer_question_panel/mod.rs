//! DS ComposerQuestionPanel (ComposerQuestionPanel.tsx / QuestionActions.tsx / QuestionOptions.tsx
//! / useQuestionPanel.ts): one to four questions in place of the composer input, with option
//! rows (single, multiple or free text), tabs and a review step for several. Local form state
//! only; the caller owns delivery, errors, collapse and transcript insertion.
mod model;
mod options;

use std::rc::Rc;

use gpui::{
    AnyElement, App, ElementId, IntoElement, KeyDownEvent, ParentElement as _, RenderOnce,
    SharedString, Styled as _, Window, div,
};

pub use model::{Answer, Labels, PanelState, Question, QuestionKind, QuestionOption, answer_text};
use model::{Callbacks, Ctx, Model, Run, model_of};
use options::Rows;

use crate::tokens::Length;
use crate::ui::Icon;
use crate::ui::blocks::composer_panel::{self, FrameKeys, Placement, Subject};
use crate::ui::button::{Button, Size, Variant};
use crate::ui::context::Ds;
use crate::ui::icon::{IconSize, icon};
use crate::ui::icon_button::IconButton;
use crate::ui::pill_button::PillButton;
use crate::ui::spinner::Spinner;
use crate::ui::tabs::{ListVariant, Tabs, TabsList, Trigger};
use crate::ui::typo::{Tone, Typo, Weight, Wrap};

type Submit = Rc<dyn Fn(&[Answer], &mut Window, &mut App)>;
type Draft = Rc<dyn Fn(&[Answer], usize, &mut App)>;

#[derive(IntoElement)]
pub struct ComposerQuestionPanel {
    id: ElementId,
    questions: Vec<Question>,
    labels: Labels,
    state: PanelState,
    error: Option<SharedString>,
    placement: Placement,
    defaults: Vec<Answer>,
    step: usize,
    on_submit: Submit,
    on_skip: Run,
    on_collapse: Run,
    on_expand: Option<Run>,
    on_draft: Option<Draft>,
}

impl ComposerQuestionPanel {
    /// One to four questions; `on_submit` hears the answers once the last is sent.
    pub fn new(
        id: impl Into<ElementId>,
        questions: Vec<Question>,
        on_submit: impl Fn(&[Answer], &mut Window, &mut App) + 'static,
    ) -> Self {
        Self {
            id: id.into(),
            questions,
            labels: Labels::default(),
            state: PanelState::Open,
            error: None,
            placement: Placement::Composer,
            defaults: Vec::new(),
            step: 0,
            on_submit: Rc::new(on_submit),
            on_skip: Rc::new(|_, _| {}),
            on_collapse: Rc::new(|_, _| {}),
            on_expand: None,
            on_draft: None,
        }
    }

    pub fn labels(mut self, labels: Labels) -> Self {
        self.labels = labels;
        self
    }

    pub fn state(mut self, state: PanelState) -> Self {
        self.state = state;
        self
    }

    pub fn error(mut self, error: impl Into<SharedString>) -> Self {
        self.error = Some(error.into());
        self
    }

    pub fn placement(mut self, placement: Placement) -> Self {
        self.placement = placement;
        self
    }

    /// Answers to restore when the owner remounts the panel.
    pub fn default_answers(mut self, answers: Vec<Answer>) -> Self {
        self.defaults = answers;
        self
    }

    pub fn default_step(mut self, step: usize) -> Self {
        self.step = step;
        self
    }

    pub fn on_skip(mut self, handler: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_skip = Rc::new(handler);
        self
    }

    /// Answer later: runs after the panel has left.
    pub fn on_collapse(mut self, handler: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_collapse = Rc::new(handler);
        self
    }

    /// The collapsed pill's action.
    pub fn on_expand(mut self, handler: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_expand = Some(Rc::new(handler));
        self
    }

    /// A snapshot after each change, for restoring a draft.
    pub fn on_draft_change(
        mut self,
        handler: impl Fn(&[Answer], usize, &mut App) + 'static,
    ) -> Self {
        self.on_draft = Some(Rc::new(handler));
        self
    }
}

/// The pieces of one render.
struct View<'a> {
    id: &'a ElementId,
    ctx: Ctx,
    labels: &'a Labels,
    model: gpui::Entity<Model>,
    leave: gpui::Entity<Option<Run>>,
    state: PanelState,
    placement: Placement,
}

impl RenderOnce for ComposerQuestionPanel {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        if !(1..=4).contains(&self.questions.len()) {
            return div().into_any_element();
        }
        if self.state == PanelState::Collapsed {
            let ds = Ds::get(cx);
            let mut pill = PillButton::new((self.id.clone(), "pending"))
                .icon(icon(Icon::MessageSquare, IconSize::Md, ds))
                .child(self.labels.pending.clone());
            match self.on_expand {
                Some(expand) => pill = pill.on_click(move |_, window, cx| expand(window, cx)),
                None => pill = pill.disabled(),
            }
            return pill.into_any_element();
        }
        let leave = window.use_keyed_state((self.id.clone(), "leave"), cx, |_, _| None::<Run>);
        let leaving =
            composer_panel::exit_progress(self.id.clone(), leave.read(cx).is_some(), window, cx);
        if leaving >= 0.999
            && let Some(run) = leave.update(cx, |leave, _| leave.take())
        {
            window.defer(cx, move |window, cx| run(window, cx));
        }
        let busy = matches!(self.state, PanelState::Working | PanelState::Submitting)
            || leave.read(cx).is_some();
        let ctx = Ctx {
            questions: Rc::new(self.questions.clone()),
            callbacks: Rc::new(Callbacks {
                submit: self.on_submit.clone(),
                skip: self.on_skip.clone(),
                collapse: self.on_collapse.clone(),
                draft: self.on_draft.clone(),
            }),
            busy,
        };
        let model = model_of(
            &self.id,
            &self.questions,
            &self.defaults,
            self.step,
            window,
            cx,
        );
        let view = View {
            id: &self.id,
            ctx,
            labels: &self.labels,
            model,
            leave,
            state: self.state,
            placement: self.placement,
        };
        let content = view.content(self.error.as_ref(), window, cx);
        let keys = FrameKeys {
            id: self.id.clone(),
            on_key: view.key_handler(),
        };
        composer_panel::frame(self.placement, keys, leaving, content, window, cx)
    }
}

/// Starts the exit; the owner's collapse runs once the panel has left.
fn leave_then(leave: &gpui::Entity<Option<Run>>, run: &Run, cx: &mut App) {
    let run = run.clone();
    leave.update(cx, |leave, cx| {
        if leave.is_none() {
            *leave = Some(run);
        }
        cx.notify();
    });
}

impl View<'_> {
    fn content(
        &self,
        error: Option<&SharedString>,
        window: &mut Window,
        cx: &mut App,
    ) -> AnyElement {
        let current = self.model.read(cx);
        let snapshot = Model {
            step: current.step,
            answers: current.answers.clone(),
            highlight: current.highlight,
            other_open: current.other_open,
        };
        let many = self.ctx.questions.len() > 1;
        let review = snapshot.review(&self.ctx);
        let step = snapshot.step;
        let rows = Rows {
            id: self.id,
            ctx: &self.ctx,
            labels: self.labels,
            model: &self.model,
            step,
            snapshot: &snapshot,
        };
        let body_content = match self.ctx.questions.get(step) {
            Some(question) if !review => options::options(&rows, question, window, cx),
            _ => options::review(&rows, cx),
        };
        let ds = Ds::get(cx);
        let placement = self.placement;
        let (eyebrow, title) = if review {
            (self.labels.review.clone(), self.labels.send.clone())
        } else {
            let question = &self.ctx.questions[step];
            (question.header.clone(), question.text.clone())
        };
        let later = {
            let (leave, run) = (self.leave.clone(), self.ctx.callbacks.collapse.clone());
            let mut button = IconButton::new((self.id.clone(), "later"), self.labels.later.clone())
                .icon(icon(Icon::Clock3, IconSize::Md, ds))
                .on_click(move |_, _, cx| leave_then(&leave, &run, cx));
            if self.ctx.busy {
                button = button.disabled();
            }
            button
        };
        let subject = composer_panel::header(
            Subject {
                icon: icon(Icon::ListChecks, IconSize::Sm, ds).into_any_element(),
                eyebrow: Some(eyebrow),
                title: Typo::label(title)
                    .weight(Weight::Medium)
                    .wrap(Wrap::Anywhere)
                    .into_any_element(),
                aside: Some(later.into_any_element()),
                tabbed: many,
                has_body: true,
            },
            placement,
            ds,
        );
        let body = composer_panel::body(
            (self.id.clone(), "question-options-scroll"),
            !many,
            body_content,
            placement,
            ds,
        );
        let inset = placement.inset(ds);
        let error = (self.state == PanelState::Error)
            .then_some(error)
            .flatten()
            .map(|text| {
                div()
                    .px(inset)
                    .child(Typo::caption(text.clone()).tone(Tone::Secondary))
            });
        let actions = self.actions(&snapshot, ds);
        let panel = div()
            .flex()
            .flex_col()
            .min_w_0()
            .child(subject)
            .child(body)
            .children(error)
            .child(actions);
        if many {
            self.tabbed(step, panel, ds)
        } else {
            panel.into_any_element()
        }
    }

    /// The tab row (one tab per question, then the review) over the current step's panel.
    fn tabbed(&self, step: usize, panel: gpui::Div, ds: &Ds) -> AnyElement {
        let triggers = self
            .ctx
            .questions
            .iter()
            .enumerate()
            .map(|(index, question)| (index.to_string(), question.header.clone()))
            .chain([(
                self.ctx.questions.len().to_string(),
                self.labels.review.clone(),
            )])
            .map(|(value, label)| {
                let trigger = Trigger::new(value, label);
                if self.ctx.busy {
                    trigger.disabled()
                } else {
                    trigger
                }
            });
        let list = TabsList::new(self.labels.select.clone())
            .variant(ListVariant::Line)
            .triggers(triggers);
        let (model, ctx) = (self.model.clone(), self.ctx.clone());
        // `.tabInset`: the list sits in the panel's inset, `--space-sm` below the top edge.
        let tabs = Tabs::new((self.id.clone(), "tabs"))
            .value(step.to_string())
            .on_value_change(move |value, _, cx| {
                if let Ok(index) = value.parse::<usize>() {
                    model.update(cx, |model, cx| {
                        model.go(index, &ctx, cx);
                        cx.notify();
                    });
                }
            })
            .list(list);
        div()
            .flex()
            .flex_col()
            .child(
                div()
                    .min_w_0()
                    .pt(ds.len(Length::SpaceSm))
                    .px(self.placement.inset(ds))
                    .child(tabs),
            )
            .child(panel)
            .into_any_element()
    }

    fn actions(&self, snapshot: &Model, ds: &Ds) -> AnyElement {
        let questions = &self.ctx.questions;
        let many = questions.len() > 1;
        let review = snapshot.review(&self.ctx);
        let step = snapshot.step;
        let can_send = review
            || questions.get(step).is_some_and(|question| {
                !answer_text(question, snapshot.answers.get(step)).is_empty()
            });
        let immediate = !many
            && questions
                .first()
                .is_some_and(|question| question.kind == QuestionKind::Single)
            && !snapshot.other_open
            && snapshot
                .answers
                .first()
                .is_some_and(|answer| answer.other.is_empty());
        let busy = self.ctx.busy;
        let mut buttons: Vec<AnyElement> = Vec::new();
        if many {
            let (model, ctx) = (self.model.clone(), self.ctx.clone());
            let mut back = Button::new((self.id.clone(), "back"))
                .size(Size::Sm)
                .variant(Variant::Borderless)
                .text(self.labels.back.clone())
                .on_click(move |_, _, cx| {
                    model.update(cx, |model, cx| {
                        model.go(model.step.saturating_sub(1), &ctx, cx);
                        cx.notify();
                    });
                });
            if busy || step == 0 {
                back = back.disabled();
            }
            buttons.push(back.into_any_element());
        }
        if !review {
            buttons.push(self.skip_button(many, busy).into_any_element());
        }
        if !immediate || busy {
            let (model, ctx) = (self.model.clone(), self.ctx.clone());
            let label = if many && !review {
                self.labels.next.clone()
            } else {
                self.labels.send.clone()
            };
            let mut next = Button::new((self.id.clone(), "next"))
                .size(Size::Sm)
                .text(label)
                .on_click(move |_, window, cx| {
                    model.update(cx, |model, cx| {
                        if review {
                            model.send(&ctx, window, cx);
                        } else {
                            model.advance(&ctx, window, cx);
                        }
                        cx.notify();
                    });
                });
            if self.state == PanelState::Submitting {
                next = next.icon_start(Spinner::new((self.id.clone(), "submitting")).size(14.));
            }
            if busy || !can_send {
                next = next.disabled();
            }
            buttons.push(next.into_any_element());
        }
        let working = (self.state == PanelState::Working).then(|| {
            div()
                .mr_auto()
                .child(Typo::caption(self.labels.working.clone()).tone(Tone::Tertiary))
                .into_any_element()
        });
        let row = working.into_iter().chain(buttons).collect();
        composer_panel::actions(row, self.placement, ds)
    }

    /// Skip: one question reports it; several record a skipped answer and move on.
    fn skip_button(&self, many: bool, busy: bool) -> Button {
        let (model, ctx) = (self.model.clone(), self.ctx.clone());
        let mut skip = Button::new((self.id.clone(), "skip"))
            .size(Size::Sm)
            .variant(Variant::Secondary)
            .text(self.labels.skip.clone())
            .on_click(move |_, window, cx| {
                if !many {
                    (ctx.callbacks.skip)(window, cx);
                    return;
                }
                model.update(cx, |model, cx| {
                    model.update(
                        |answer| {
                            answer.selected.clear();
                            answer.text.clear();
                            answer.other.clear();
                            answer.skipped = true;
                        },
                        &ctx,
                        cx,
                    );
                    model.go(model.step + 1, &ctx, cx);
                    cx.notify();
                });
            });
        if busy {
            skip = skip.disabled();
        }
        skip
    }

    /// `useQuestionPanel.keyDown`: Escape collapses, arrows move between questions and options,
    /// digits choose, Space toggles a multiple choice, Enter chooses or advances.
    fn key_handler(&self) -> Rc<dyn Fn(&KeyDownEvent, bool, &mut Window, &mut App)> {
        let (model, ctx, leave) = (self.model.clone(), self.ctx.clone(), self.leave.clone());
        let run = self.ctx.callbacks.collapse.clone();
        Rc::new(move |event, _own, window, cx| {
            let modifiers = event.keystroke.modifiers;
            if ctx.busy || event.is_held || modifiers.alt || modifiers.control || modifiers.platform
            {
                return;
            }
            let key = event.keystroke.key.as_str();
            if key == "escape" {
                cx.stop_propagation();
                leave_then(&leave, &run, cx);
                return;
            }
            model.update(cx, |model, cx| {
                if navigate(model, key, &ctx, window, cx) {
                    cx.stop_propagation();
                    cx.notify();
                }
            });
        })
    }
}

/// One key on the panel itself; whether it was ours.
fn navigate(model: &mut Model, key: &str, ctx: &Ctx, window: &mut Window, cx: &mut App) -> bool {
    let many = ctx.questions.len() > 1;
    if many && matches!(key, "left" | "right") {
        let next = if key == "right" {
            model.step + 1
        } else {
            model.step.saturating_sub(1)
        };
        model.go(next, ctx, cx);
        return true;
    }
    if model.review(ctx) {
        if key == "enter" {
            model.send(ctx, window, cx);
            return true;
        }
        return false;
    }
    let question = &ctx.questions[model.step];
    if question.kind == QuestionKind::Text {
        return false;
    }
    let last = question.options.len() + usize::from(question.allow_other);
    if let Some(n) = key
        .parse::<usize>()
        .ok()
        .filter(|n| (1..=9).contains(n) && *n <= last)
    {
        model.choose(n - 1, ctx, window, cx);
        return true;
    }
    match key {
        "down" | "up" => {
            let delta = if key == "down" { 1 } else { -1 };
            model.highlight = model.highlight.saturating_add_signed(delta).min(last - 1);
            true
        }
        "space" if question.kind == QuestionKind::Multi => {
            model.choose(model.highlight, ctx, window, cx);
            true
        }
        "enter" if question.kind == QuestionKind::Single => {
            model.choose(model.highlight, ctx, window, cx);
            true
        }
        "enter" => {
            if !answer_text(question, model.answers.get(model.step)).is_empty() {
                model.advance(ctx, window, cx);
            }
            true
        }
        _ => false,
    }
}
