//! DS ComposerQuestionPanel (ComposerQuestionPanel.tsx / QuestionActions.tsx / QuestionOptions.tsx
//! / useQuestionPanel.ts): one to four questions in place of the composer input, with option
//! rows (single, multiple or free text), tabs and a review step for several. Local form state
//! only; the caller owns delivery, errors, collapse and transcript insertion.
mod actions;
mod model;
mod options;

use std::rc::Rc;

use gpui::{
    AnyElement, App, ElementId, IntoElement, ParentElement as _, RenderOnce, SharedString,
    Styled as _, Window, div,
};

pub use model::{Answer, Labels, PanelState, Question, QuestionKind, QuestionOption, answer_text};
use model::{Callbacks, Ctx, Model, Run, model_of};
use options::Rows;

use crate::ui::Icon;
use crate::ui::blocks::composer_panel::{self, FrameKeys, Placement, Subject};
use crate::ui::context::Ds;
use crate::ui::icon::{IconSize, icon};
use crate::ui::icon_button::IconButton;
use crate::ui::pill_button::PillButton;
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
    on_collapse: Option<Run>,
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
            on_collapse: None,
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

    /// Answer later. Unset: no Later button, Escape does nothing. In
    /// `Placement::Conversation` the panel never collapses: Later runs at once
    /// (no exit motion) and the caller keeps the panel open (ComposerQuestionPanel.tsx).
    pub fn on_collapse(mut self, handler: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_collapse = Some(Rc::new(handler));
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
        if leaving.target() == 1.
            && !leaving.moving(&crate::ui::motion::Timing::token(
                Ds::get(cx),
                crate::tokens::Duration::MotionExitBase,
                crate::tokens::Easing::MotionEaseAccelerate,
            ))
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
        let subject = self.subject(eyebrow, title, many, ds);
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

    /// The header: icon, eyebrow, title and the "later" button.
    fn subject(
        &self,
        eyebrow: SharedString,
        title: SharedString,
        many: bool,
        ds: &Ds,
    ) -> AnyElement {
        let later = self.ctx.callbacks.collapse.clone().map(|run| {
            let leave = self.leave.clone();
            let placement = self.placement;
            let mut button = IconButton::new((self.id.clone(), "later"), self.labels.later.clone())
                .icon(icon(Icon::Clock3, IconSize::Md, ds))
                .on_click(move |_, window, cx| {
                    if placement == Placement::Conversation {
                        run(window, cx);
                    } else {
                        leave_then(&leave, &run, cx);
                    }
                });
            if self.ctx.busy {
                button = button.disabled();
            }
            button.into_any_element()
        });
        composer_panel::header(
            Subject {
                icon: icon(Icon::ListChecks, IconSize::Sm, ds).into_any_element(),
                eyebrow: Some(eyebrow),
                title: Typo::label(title)
                    .weight(Weight::Medium)
                    .wrap(Wrap::Anywhere)
                    .into_any_element(),
                aside: later,
                tabbed: many,
                has_body: true,
            },
            self.placement,
            ds,
        )
    }
}
