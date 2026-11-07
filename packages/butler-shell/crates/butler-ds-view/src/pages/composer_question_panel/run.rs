//! One showcase panel: the owner's state, the answered card and the collapsed reply composer.
use butler_ds::ui::blocks::composer_card::{ComposerCard, Toolbar, textarea};
use butler_ds::ui::blocks::composer_panel::Placement;
use butler_ds::ui::blocks::composer_question_panel::{
    Answer, ComposerQuestionPanel, PanelState, Question,
};
use butler_ds::ui::blocks::question_answer_card as card;
use butler_ds::ui::button::{Button, Size};
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::typo::Typo;
use gpui::{AnyElement, App, Entity, IntoElement as _, ParentElement as _, SharedString, Window};

use super::fixtures::{Kind, fixtures};
use super::{Outcome, card_answer, card_labels, card_question, filled, labels, reset};
use crate::copy::Lang;
use crate::pages::sub;

pub(super) struct Demo {
    key: &'static str,
    kind: Kind,
    initial: PanelState,
    step: usize,
}

pub(super) fn demo(key: &'static str, kind: Kind, initial: PanelState, step: usize) -> Demo {
    Demo {
        key,
        kind,
        initial,
        step,
    }
}

/// What the demo's owner holds besides the panel's own form state.
struct Session {
    state: Entity<PanelState>,
    result: Entity<Option<(Outcome, Vec<Answer>)>>,
    message: Entity<String>,
    draft: Entity<Option<(Vec<Answer>, usize)>>,
    revision: Entity<usize>,
}

impl Session {
    fn new(demo: &Demo, window: &mut Window, cx: &mut App) -> Self {
        let key = demo.key;
        let initial = demo.initial;
        Self {
            state: window.use_keyed_state(sub(key, "state"), cx, move |_, _| initial),
            result: window.use_keyed_state(sub(key, "result"), cx, |_, _| None),
            message: window.use_keyed_state(sub(key, "message"), cx, |_, _| String::new()),
            draft: window.use_keyed_state(sub(key, "draft"), cx, |_, _| None),
            revision: window.use_keyed_state(sub(key, "revision"), cx, |_, _| 0),
        }
    }
}

/// The line of Butler's text above the panel.
fn intro(lang: Lang, kind: Kind) -> &'static str {
    lang.pick(
        if kind == Kind::Onboarding {
            "Hello, I’m Butler. Let’s start with three questions."
        } else {
            "Ready. Choose a few details."
        },
        if kind == Kind::Onboarding {
            "안녕하세요, 버틀러예요. 세 가지만 여쭤볼게요."
        } else {
            "준비됐어요. 몇 가지만 정해 주세요."
        },
    )
}

pub(super) fn run(lang: Lang, demo: Demo, window: &mut Window, cx: &mut App) -> AnyElement {
    let questions = fixtures(lang, demo.kind);
    let session = Session::new(&demo, window, cx);
    let stack = Stack::new()
        .gap(Space::Md)
        .child(Typo::body(intro(lang, demo.kind)));
    if let Some((outcome, answers)) = session.result.read(cx).clone() {
        return answered(
            lang,
            &demo,
            &session,
            stack,
            &questions,
            (outcome, &answers),
            cx,
        );
    }
    open(lang, &demo, &session, stack, questions, cx)
}

/// The answered card and the reset that brings the panel back.
fn answered(
    lang: Lang,
    demo: &Demo,
    session: &Session,
    stack: Stack,
    questions: &[Question],
    (outcome, answers): (Outcome, &[Answer]),
    cx: &mut App,
) -> AnyElement {
    let key = demo.key;
    let cards: Vec<card::Question> = questions.iter().map(card_question).collect();
    let given: Vec<card::Answer> = answers.iter().map(card_answer).collect();
    let variant = match outcome {
        Outcome::Answered => card::Variant::Answered,
        Outcome::Skipped => card::Variant::Skipped,
        Outcome::Message => card::Variant::Message,
    };
    let text = session.message.read(cx).clone();
    let answer_card = card::QuestionAnswerCard::new(sub(key, "card"), cards)
        .answers(given)
        .variant(variant)
        .labels(card_labels(lang))
        .message(text);
    let (result, state, draft, revision, initial) = (
        session.result.clone(),
        session.state.clone(),
        session.draft.clone(),
        session.revision.clone(),
        demo.initial,
    );
    stack
        .child(answer_card)
        .child(reset(
            lang.pick("Reset", "다시"),
            SharedString::from(format!("{key}-reset")),
            move |cx| {
                result.update(cx, |value, cx| {
                    *value = None;
                    cx.notify();
                });
                state.update(cx, |value, cx| {
                    *value = initial;
                    cx.notify();
                });
                draft.update(cx, |value, _| *value = None);
                revision.update(cx, |value, cx| {
                    *value += 1;
                    cx.notify();
                });
            },
        ))
        .into_any_element()
}

/// The answers and step to restore: the draft, else a filled form where the demo asks for one.
fn restored(
    lang: Lang,
    demo: &Demo,
    session: &Session,
    questions: &[Question],
    cx: &App,
) -> (Vec<Answer>, usize) {
    let defaults = match session.draft.read(cx).clone() {
        Some((answers, _)) => answers,
        None if demo.initial == PanelState::Error || demo.step == questions.len() => {
            filled(lang, questions)
        }
        None => Vec::new(),
    };
    let step = session
        .draft
        .read(cx)
        .as_ref()
        .map_or(demo.step, |(_, step)| *step);
    (defaults, step)
}

/// The panel with the owner's callbacks wired to the session.
fn panel(
    lang: Lang,
    demo: &Demo,
    session: &Session,
    questions: &[Question],
    cx: &App,
) -> ComposerQuestionPanel {
    let key = demo.key;
    let current = *session.state.read(cx);
    let panel_id: SharedString = format!("{key}-panel-{}", *session.revision.read(cx)).into();
    let (defaults, step) = restored(lang, demo, session, questions, cx);
    let (set_done, set_skip, set_collapse, set_expand, set_draft) = (
        session.result.clone(),
        session.result.clone(),
        session.state.clone(),
        session.state.clone(),
        session.draft.clone(),
    );
    let skip_questions = questions.to_vec();
    ComposerQuestionPanel::new(panel_id, questions.to_vec(), move |answers, _, cx| {
        let answers = answers.to_vec();
        set_done.update(cx, |value, cx| {
            *value = Some((Outcome::Answered, answers));
            cx.notify();
        });
    })
    .labels(labels(lang))
    .state(current)
    .default_answers(defaults)
    .default_step(step)
    .error(lang.pick(
        "Could not send. Try again.",
        "보내지 못했습니다. 다시 시도하세요.",
    ))
    .on_skip(move |_, cx| {
        let answers = skip_questions
            .iter()
            .map(|q| Answer::empty(q.id.clone()))
            .collect();
        set_skip.update(cx, |value, cx| {
            *value = Some((Outcome::Skipped, answers));
            cx.notify();
        });
    })
    .on_collapse(move |_, cx| {
        set_collapse.update(cx, |value, cx| {
            *value = PanelState::Collapsed;
            cx.notify();
        })
    })
    .on_expand(move |_, cx| {
        set_expand.update(cx, |value, cx| {
            *value = PanelState::Open;
            cx.notify();
        })
    })
    .on_draft_change(move |answers, step, cx| {
        set_draft.update(cx, |value, _| *value = Some((answers.to_vec(), step)));
    })
    .placement(Placement::Composer)
}

/// The composer that answers by message while the panel is collapsed.
fn reply_composer(
    lang: Lang,
    key: &'static str,
    session: &Session,
    questions: Vec<Question>,
    cx: &App,
) -> ComposerCard {
    let text = session.message.read(cx).clone();
    let (set_text, send_result) = (session.message.clone(), session.result.clone());
    let mut send = Button::new(sub(key, "send"))
        .size(Size::Sm)
        .text(lang.pick("Send", "보내기"))
        .on_click(move |_, _, cx| {
            let answers = questions
                .iter()
                .map(|q| Answer::empty(q.id.clone()))
                .collect();
            send_result.update(cx, |value, cx| {
                *value = Some((Outcome::Message, answers));
                cx.notify();
            });
        });
    if text.trim().is_empty() {
        send = send.disabled();
    }
    ComposerCard::new(sub(key, "card"))
        .child(
            textarea(sub(key, "message"))
                .placeholder(lang.pick("Write a message", "메시지 작성"))
                .on_change(move |value, _, cx| {
                    let value = value.to_owned();
                    set_text.update(cx, |text, cx| {
                        *text = value;
                        cx.notify();
                    });
                }),
        )
        .child(Toolbar::new().child(send))
}

/// The open (or collapsed) panel in its composer.
fn open(
    lang: Lang,
    demo: &Demo,
    session: &Session,
    stack: Stack,
    questions: Vec<Question>,
    cx: &mut App,
) -> AnyElement {
    let key = demo.key;
    let panel = panel(lang, demo, session, &questions, cx);
    if *session.state.read(cx) == PanelState::Collapsed {
        let composer = reply_composer(lang, key, session, questions, cx);
        return stack.child(panel).child(composer).into_any_element();
    }
    stack
        .child(ComposerCard::new(sub(key, "card")).child(panel))
        .into_any_element()
}
