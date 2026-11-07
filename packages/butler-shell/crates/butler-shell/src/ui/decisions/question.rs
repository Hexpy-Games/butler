//! the question panel (useComposerQuestion, userQuestions.ts).
use std::rc::Rc;

use butler_ds::ui::blocks::composer_question_panel::{
    Answer, ComposerQuestionPanel, PanelState, Question, QuestionKind, QuestionOption,
};
use butler_shell_client::AuthorityDecision;
use gpui::{AnyElement, App, ElementId, Entity, Global, IntoElement as _, SharedString, Window};

use super::DecisionCtx;
use crate::ui::i18n::question::QuestionCopy;
use crate::ui::source::agent::Jobs;
use crate::ui::source::wire::{
    PendingUserQuestionsQuestionState, QuestionAnswerBody, QuestionAnswerReply,
    QuestionAnswerWire, UserQuestion, UserQuestionKind, UserQuestionOptionsItem,
    UserQuestionOptionsItemKind,
};

/// The hook's `useState` / `useRef` values.
#[derive(Default)]
struct QuestionState {
    collapsed: Option<String>,
    pending: Option<String>,
    failed: Option<String>,
    draft: Option<(String, Vec<Answer>, usize)>,
    in_flight: Option<String>,
}

type Answered = Rc<dyn Fn(&mut App)>;

#[derive(Default)]
struct QuestionAnswered(Option<Answered>);

impl Global for QuestionAnswered {}

/// Registers what refreshes the session view and the authority approvals once an answer was
/// accepted (`refreshSessionView`, `refreshAuthorityApprovals`).
pub(crate) fn on_question_answered(cx: &mut App, handler: impl Fn(&mut App) + 'static) {
    cx.default_global::<QuestionAnswered>().0 = Some(Rc::new(handler));
}

fn question_answered(cx: &mut App) {
    if let Some(handler) = cx
        .try_global::<QuestionAnswered>()
        .and_then(|answered| answered.0.clone())
    {
        handler(cx);
    }
}

/// Concrete answers only: the card has its own Skip and free input, so options of those kinds
/// never show.
fn answer_options(question: &UserQuestion) -> Vec<&UserQuestionOptionsItem> {
    if question.kind == UserQuestionKind::Text {
        return Vec::new();
    }
    question
        .options
        .iter()
        .filter(|option| {
            option
                .kind
                .as_ref()
                .is_none_or(|kind| *kind == UserQuestionOptionsItemKind::Answer)
        })
        .collect()
}

/// `questionProps`.
fn question_props(questions: &[UserQuestion]) -> Vec<Question> {
    questions
        .iter()
        .map(|q| {
            let options = answer_options(q);
            let text = options.is_empty();
            let kind = match q.kind {
                _ if text => QuestionKind::Text,
                UserQuestionKind::Multi => QuestionKind::Multi,
                _ => QuestionKind::Single,
            };
            Question {
                id: q.id.clone().into(),
                header: q.eyebrow.clone().into(),
                text: q.title.clone().into(),
                kind,
                allow_other: !text && (q.allow_custom || options.len() < q.options.len()),
                options: options
                    .iter()
                    .map(|o| {
                        let mut option = QuestionOption::new(o.label.clone());
                        if let Some(description) = &o.description {
                            option = option.description(description.clone());
                        }
                        if o.recommended == Some(true) {
                            option = option.recommended();
                        }
                        option
                    })
                    .collect(),
                placeholder: None,
            }
        })
        .collect()
}

fn non_empty(text: &str) -> Option<&str> {
    Some(text.trim()).filter(|t| !t.is_empty())
}

/// `answerWire`.
fn answer_wire(questions: &[UserQuestion], answers: &[Answer]) -> Vec<QuestionAnswerWire> {
    questions
        .iter()
        .map(|q| {
            let answer = answers.iter().find(|a| &*a.id == q.id.as_str());
            let options = answer_options(q);
            QuestionAnswerWire {
                id: q.id.clone(),
                selected: answer
                    .map(|a| {
                        a.selected
                            .iter()
                            .filter_map(|i| options.get(*i).map(|o| o.id.clone()))
                            .collect()
                    })
                    .unwrap_or_default(),
                custom: answer.and_then(|a| {
                    non_empty(&a.other)
                        .or_else(|| non_empty(&a.text))
                        .map(str::to_owned)
                }),
                skipped: answer.is_none_or(|a| a.skipped),
            }
        })
        .collect()
}

/// What one pending request's callbacks need.
#[derive(Clone)]
struct Request {
    state: Entity<QuestionState>,
    session: String,
    reference: String,
    key: String,
    questions: Rc<Vec<UserQuestion>>,
}

impl Request {
    /// `submit`: sends the response; a reply that is not the scheduled answer counts as failed.
    fn submit(&self, response: QuestionAnswerBody, window: &mut Window, cx: &mut App) {
        let started = self.state.update(cx, |state, cx| {
            if state.in_flight.as_ref() == Some(&self.key) {
                return false;
            }
            state.in_flight = Some(self.key.clone());
            state.pending = Some(self.key.clone());
            state.failed = None;
            cx.notify();
            true
        });
        if !started {
            return;
        }
        window.refresh();
        let (session, request_ref) = (self.session.clone(), self.reference.clone());
        let done = Jobs::run(cx, move |client| async move {
            let body = serde_json::to_value(&response).ok()?;
            let reply = client
                .answer_authority(&session, &request_ref, AuthorityDecision::Answer(body))
                .await
                .ok()?;
            let reply: QuestionAnswerReply = serde_json::from_value(reply).ok()?;
            (reply.request_ref == request_ref
                && reply.decision == "modified"
                && reply.scheduled == Some(true))
            .then_some(())
        });
        let (state, key) = (self.state.clone(), self.key.clone());
        cx.spawn(async move |cx| {
            let accepted = done.await.flatten().is_some();
            state.update(cx, |state, cx| {
                state.in_flight = None;
                state.pending = None;
                if !accepted {
                    state.failed = Some(key);
                }
                cx.notify();
            });
            if accepted {
                cx.update(question_answered);
            }
        })
        .detach();
    }

    fn answered(&self, answers: &[Answer], window: &mut Window, cx: &mut App) {
        let answers = answer_wire(&self.questions, answers);
        self.submit(QuestionAnswerBody::Answered { answers }, window, cx);
    }

    fn set_collapsed(&self, value: String, cx: &mut App) {
        self.state.update(cx, |state, cx| {
            state.collapsed = Some(value);
            cx.notify();
        });
    }
}

/// the question panel (useComposerQuestion); `None` when this session has nothing for it.
pub(crate) fn question_surface(
    ctx: DecisionCtx<'_>,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let session = ctx.view.session_id.clone();
    let state = window.use_keyed_state("composer-question-state", cx, |_, _| {
        QuestionState::default()
    });
    let pending = ctx.view.pending_questions.as_ref()?.first()?;
    let key = format!("{session}:{}", pending.request_ref);
    let questions = &pending.questions.questions;
    let copy = QuestionCopy::get(cx);
    let deferred = pending.question_state == PendingUserQuestionsQuestionState::Deferred;
    let request = Request {
        state: state.clone(),
        session,
        reference: pending.request_ref.clone(),
        key: key.clone(),
        questions: Rc::new(questions.clone()),
    };
    let current = state.read(cx);
    let failed = current.failed.as_ref() == Some(&key);
    let collapsed = current.collapsed.as_ref() == Some(&key)
        || (deferred && current.collapsed.as_deref() != Some(format!("expanded:{key}").as_str()));
    let panel_state = if current.pending.as_ref() == Some(&key) {
        PanelState::Submitting
    } else if failed {
        PanelState::Error
    } else if collapsed {
        PanelState::Collapsed
    } else {
        PanelState::Open
    };
    let draft = current
        .draft
        .as_ref()
        .filter(|(draft_key, _, _)| *draft_key == key)
        .map(|(_, answers, step)| (answers.clone(), *step));
    let (submit, skip, collapse, expand, track) = (
        request.clone(),
        request.clone(),
        request.clone(),
        request.clone(),
        request,
    );
    let mut panel = ComposerQuestionPanel::new(
        ElementId::from(SharedString::from(key.clone())),
        question_props(questions),
        move |answers, window, cx| submit.answered(answers, window, cx),
    )
    .labels(copy.labels())
    .state(panel_state)
    .on_skip(move |window, cx| skip.answered(&[], window, cx))
    .on_collapse(move |window, cx| {
        collapse.set_collapsed(collapse.key.clone(), cx);
        if !deferred {
            collapse.submit(QuestionAnswerBody::Deferred {}, window, cx);
        }
    })
    .on_expand(move |_, cx| expand.set_collapsed(format!("expanded:{}", expand.key), cx))
    .on_draft_change(move |answers, step, cx| {
        let draft = (track.key.clone(), answers.to_vec(), step);
        track.state.update(cx, |state, _| state.draft = Some(draft));
    });
    if failed {
        panel = panel.error(copy.decision_failed);
    }
    if let Some((answers, step)) = draft {
        panel = panel.default_answers(answers).default_step(step);
    }
    Some(panel.into_any_element())
}
