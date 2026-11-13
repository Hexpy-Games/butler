//! ComposerQuestionPanel/types.ts and useQuestionPanel.ts: the questions, the answers and the
//! local form state (step, highlight, the open "Other" field). The caller owns delivery, errors,
//! collapse and transcript insertion.
use std::rc::Rc;

use gpui::{App, Entity, SharedString, Window};

/// `type`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QuestionKind {
    Single,
    Multi,
    Text,
}

#[derive(Clone, Debug)]
pub struct QuestionOption {
    pub label: SharedString,
    pub description: Option<SharedString>,
    pub recommended: bool,
}

impl QuestionOption {
    pub fn new(label: impl Into<SharedString>) -> Self {
        Self {
            label: label.into(),
            description: None,
            recommended: false,
        }
    }

    pub fn description(mut self, description: impl Into<SharedString>) -> Self {
        self.description = Some(description.into());
        self
    }

    pub fn recommended(mut self) -> Self {
        self.recommended = true;
        self
    }
}

#[derive(Clone, Debug)]
pub struct Question {
    pub id: SharedString,
    pub header: SharedString,
    pub text: SharedString,
    pub kind: QuestionKind,
    pub options: Vec<QuestionOption>,
    pub allow_other: bool,
    pub placeholder: Option<SharedString>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Answer {
    pub id: SharedString,
    pub selected: Vec<usize>,
    pub text: String,
    pub other: String,
    pub skipped: bool,
}

impl Answer {
    pub fn empty(id: SharedString) -> Self {
        Self {
            id,
            selected: Vec::new(),
            text: String::new(),
            other: String::new(),
            skipped: true,
        }
    }
}

/// `state`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PanelState {
    #[default]
    Open,
    Submitting,
    Error,
    Collapsed,
    Working,
}

/// `QuestionPanelLabels`.
#[derive(Clone, Debug)]
pub struct Labels {
    pub review: SharedString,
    pub send: SharedString,
    pub next: SharedString,
    pub back: SharedString,
    pub skip: SharedString,
    pub skipped: SharedString,
    pub later: SharedString,
    pub pending: SharedString,
    pub other: SharedString,
    pub recommended: SharedString,
    pub working: SharedString,
    pub select: SharedString,
}

impl Default for Labels {
    fn default() -> Self {
        let s = |text: &'static str| SharedString::new_static(text);
        Self {
            review: s("Review"),
            send: s("Send"),
            next: s("Next"),
            back: s("Back"),
            skip: s("Skip"),
            skipped: s("Skipped"),
            later: s("Answer later"),
            pending: s("Answer pending"),
            other: s("Other…"),
            recommended: s("Recommended"),
            working: s("Working"),
            select: s("Select"),
        }
    }
}

/// `answerText`: the chosen labels, the text and the other text, joined.
pub fn answer_text(question: &Question, answer: Option<&Answer>) -> String {
    let Some(answer) = answer.filter(|answer| !answer.skipped) else {
        return String::new();
    };
    let chosen = answer
        .selected
        .iter()
        .filter_map(|index| question.options.get(*index))
        .map(|option| option.label.to_string());
    chosen
        .chain([
            answer.text.trim().to_owned(),
            answer.other.trim().to_owned(),
        ])
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(", ")
}

/// The first recommended option, or the first.
fn recommended(question: Option<&Question>) -> usize {
    question
        .and_then(|question| {
            question
                .options
                .iter()
                .position(|option| option.recommended)
        })
        .unwrap_or(0)
}

pub(super) type Submit = Rc<dyn Fn(&[Answer], &mut Window, &mut App)>;
pub(super) type Run = Rc<dyn Fn(&mut Window, &mut App)>;
pub(super) type Draft = Rc<dyn Fn(&[Answer], usize, &mut App)>;

/// What a panel tells its owner.
pub(super) struct Callbacks {
    pub(super) submit: Submit,
    pub(super) skip: Run,
    pub(super) collapse: Option<Run>,
    pub(super) draft: Option<Draft>,
}

/// `useQuestionPanel`'s state.
pub(super) struct Model {
    pub(super) step: usize,
    pub(super) answers: Vec<Answer>,
    pub(super) highlight: usize,
    pub(super) other_open: bool,
}

/// The questions and callbacks a model acts with.
#[derive(Clone)]
pub(super) struct Ctx {
    pub(super) questions: Rc<Vec<Question>>,
    pub(super) callbacks: Rc<Callbacks>,
    pub(super) busy: bool,
}

impl Model {
    pub(super) fn new(questions: &[Question], defaults: &[Answer], step: usize) -> Self {
        let answers: Vec<Answer> = questions
            .iter()
            .map(|question| {
                defaults
                    .iter()
                    .find(|answer| answer.id == question.id)
                    .cloned()
                    .unwrap_or_else(|| Answer::empty(question.id.clone()))
            })
            .collect();
        Self {
            step,
            other_open: answers
                .get(step)
                .is_some_and(|answer| !answer.other.is_empty()),
            highlight: recommended(questions.get(step)),
            answers,
        }
    }

    pub(super) fn review(&self, ctx: &Ctx) -> bool {
        self.step == ctx.questions.len()
    }

    fn changed(&self, ctx: &Ctx, cx: &mut App) {
        if let Some(draft) = &ctx.callbacks.draft {
            draft(&self.answers, self.step, cx);
        }
    }

    pub(super) fn go(&mut self, next: usize, ctx: &Ctx, cx: &mut App) {
        if ctx.busy {
            return;
        }
        let index = next.min(ctx.questions.len());
        self.step = index;
        self.other_open = self
            .answers
            .get(index)
            .is_some_and(|answer| !answer.other.is_empty());
        self.highlight = recommended(ctx.questions.get(index));
        self.changed(ctx, cx);
    }

    pub(super) fn update(&mut self, patch: impl FnOnce(&mut Answer), ctx: &Ctx, cx: &mut App) {
        if let Some(answer) = self.answers.get_mut(self.step) {
            patch(answer);
        }
        self.changed(ctx, cx);
    }

    pub(super) fn send(&self, ctx: &Ctx, window: &mut Window, cx: &mut App) {
        if ctx.busy {
            return;
        }
        let values: Vec<Answer> = self
            .answers
            .iter()
            .zip(ctx.questions.iter())
            .map(|(answer, question)| Answer {
                skipped: answer_text(question, Some(answer)).is_empty(),
                ..answer.clone()
            })
            .collect();
        (ctx.callbacks.submit)(&values, window, cx);
    }

    pub(super) fn advance(&mut self, ctx: &Ctx, window: &mut Window, cx: &mut App) {
        if ctx.questions.len() > 1 {
            self.go(self.step + 1, ctx, cx);
        } else {
            self.send(ctx, window, cx);
        }
    }

    /// `choose`: a click or a number key on option `index` (the last is "Other" when allowed).
    pub(super) fn choose(&mut self, index: usize, ctx: &Ctx, window: &mut Window, cx: &mut App) {
        let Some(question) = ctx.questions.get(self.step) else {
            return;
        };
        if ctx.busy {
            return;
        }
        self.highlight = index;
        let single = question.kind == QuestionKind::Single;
        if index == question.options.len() {
            let opening = !self.other_open;
            self.other_open = opening;
            self.update(
                |answer| {
                    if !opening {
                        answer.other.clear();
                    }
                    answer.skipped = false;
                    if single {
                        answer.selected.clear();
                    }
                },
                ctx,
                cx,
            );
            return;
        }
        let multi = question.kind == QuestionKind::Multi;
        self.update(
            |answer| {
                if multi {
                    if let Some(at) = answer.selected.iter().position(|value| *value == index) {
                        answer.selected.remove(at);
                    } else {
                        answer.selected.push(index);
                        answer.selected.sort_unstable();
                    }
                } else {
                    answer.selected = vec![index];
                }
                answer.skipped = false;
                if single {
                    answer.other.clear();
                }
            },
            ctx,
            cx,
        );
        if single {
            self.other_open = false;
            if ctx.questions.len() == 1 {
                self.send(ctx, window, cx);
            } else {
                self.go(self.step + 1, ctx, cx);
            }
        }
    }
}

/// The model of panel `id`, created from the defaults the first time.
pub(super) fn model_of(
    id: &gpui::ElementId,
    questions: &[Question],
    defaults: &[Answer],
    step: usize,
    window: &mut Window,
    cx: &mut App,
) -> Entity<Model> {
    let (questions, defaults) = (questions.to_vec(), defaults.to_vec());
    window.use_keyed_state((id.clone(), "model"), cx, move |_, _| {
        Model::new(&questions, &defaults, step)
    })
}
