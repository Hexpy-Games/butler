//! ComposerQuestionPanel.showcase.tsx (+ fixtures.ts): one to four questions in place of the
//! composer input, in every state, and in the conversation. A finished panel hands its answers to
//! the QuestionAnswerCard, as the React demo does.
mod fixtures;
mod run;
mod stories;

use butler_ds::ui::blocks::composer_panel::Placement;
use butler_ds::ui::blocks::composer_question_panel::{
    Answer, ComposerQuestionPanel, Labels, PanelState, Question, QuestionKind,
};
use butler_ds::ui::blocks::question_answer_card as card;
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::typo::Typo;
use gpui::{AnyElement, App, Entity, IntoElement as _, ParentElement as _, SharedString, Window};

use self::fixtures::{Kind, fixtures};
pub(super) use self::stories::stories;
use super::sub;
use crate::copy::Lang;

/// `koLabels`, and the English defaults.
fn labels(lang: Lang) -> Labels {
    let s = |text: &'static str| SharedString::new_static(text);
    match lang {
        Lang::En => Labels::default(),
        Lang::Ko => Labels {
            review: s("확인"),
            send: s("보내기"),
            next: s("다음"),
            back: s("이전"),
            skip: s("건너뛰기"),
            skipped: s("건너뜀"),
            later: s("나중에"),
            pending: s("답변 대기"),
            other: s("직접 입력…"),
            recommended: s("추천"),
            working: s("작업 중"),
            select: s("선택"),
        },
    }
}

/// The QuestionAnswerCard's view of the panel's questions and answers.
fn card_question(question: &Question) -> card::Question {
    card::Question {
        id: question.id.clone(),
        header: question.header.clone(),
        kind: match question.kind {
            QuestionKind::Single => card::QuestionKind::Single,
            QuestionKind::Multi => card::QuestionKind::Multi,
            QuestionKind::Text => card::QuestionKind::Text,
        },
        options: question
            .options
            .iter()
            .map(|option| option.label.clone())
            .collect(),
    }
}

fn card_answer(answer: &Answer) -> card::Answer {
    card::Answer {
        id: answer.id.clone(),
        selected: answer.selected.clone(),
        text: answer.text.clone().into(),
        other: answer.other.clone().into(),
        skipped: answer.skipped,
    }
}

/// What the demo's owner holds besides the panel's own form state.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Outcome {
    Answered,
    Skipped,
    Message,
}

/// The QuestionAnswerCard's captions.
fn card_labels(lang: Lang) -> card::Labels {
    lang.pick(
        card::Labels {
            answered: "Answered".into(),
            skipped: "Skipped".into(),
            message: "Answered by message".into(),
        },
        card::Labels {
            answered: "답변 완료".into(),
            skipped: "건너뜀".into(),
            message: "메시지로 답함".into(),
        },
    )
}

/// `defaultAnswers` for a review, a retry or a given step past the questions.
fn filled(lang: Lang, questions: &[Question]) -> Vec<Answer> {
    questions
        .iter()
        .map(|q| {
            let text = q.kind == QuestionKind::Text;
            Answer {
                id: q.id.clone(),
                selected: if text { Vec::new() } else { vec![0] },
                text: if text {
                    lang.pick("Alex", "민수").to_owned()
                } else {
                    String::new()
                },
                other: String::new(),
                skipped: false,
            }
        })
        .collect()
}

fn reset(label: &'static str, id: SharedString, on: impl Fn(&mut App) + 'static) -> AnyElement {
    Button::new(id)
        .size(Size::Sm)
        .variant(Variant::Borderless)
        .text(label)
        .on_click(move |_, _, cx| on(cx))
        .into_any_element()
}

/// `placement="conversation"`: the question where Butler asked it, with a reset once answered.
fn conversation(
    lang: Lang,
    key: &'static str,
    kind: Kind,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let questions = fixtures(lang, kind);
    let state: Entity<PanelState> =
        window.use_keyed_state(sub(key, "state"), cx, |_, _| PanelState::Open);
    let result: Entity<Option<Vec<Answer>>> =
        window.use_keyed_state(sub(key, "result"), cx, |_, _| None);
    let revision: Entity<usize> = window.use_keyed_state(sub(key, "revision"), cx, |_, _| 0);
    let text = lang.pick(
        "Search results now sort by last modified.",
        "검색 결과를 최근 수정순으로 바꿨습니다.",
    );
    let stack = Stack::new().gap(Space::Md).child(Typo::body(text));
    if let Some(answers) = result.read(cx).clone() {
        let cards: Vec<card::Question> = questions.iter().map(card_question).collect();
        let given: Vec<card::Answer> = answers.iter().map(card_answer).collect();
        let answer_card = card::QuestionAnswerCard::new(sub(key, "card"), cards)
            .answers(given)
            .variant(card::Variant::Answered)
            .labels(card_labels(lang));
        let reset = conversation_reset(lang, key, (result, state, revision));
        return stack.child(answer_card).child(reset).into_any_element();
    }
    let panel_id: SharedString = format!("{key}-panel-{}", *revision.read(cx)).into();
    let panel = conversation_panel(lang, panel_id, questions, &result, &state, cx);
    stack.child(panel).into_any_element()
}

/// The reset below an answered conversation card.
fn conversation_reset(
    lang: Lang,
    key: &'static str,
    (result, state, revision): (
        Entity<Option<Vec<Answer>>>,
        Entity<PanelState>,
        Entity<usize>,
    ),
) -> AnyElement {
    reset(
        lang.pick("Reset", "다시"),
        SharedString::from(format!("{key}-reset")),
        move |cx| {
            result.update(cx, |value, cx| {
                *value = None;
                cx.notify();
            });
            state.update(cx, |value, cx| {
                *value = PanelState::Open;
                cx.notify();
            });
            revision.update(cx, |value, cx| {
                *value += 1;
                cx.notify();
            });
        },
    )
}

/// The panel in the transcript, its callbacks wired to the owner's state.
fn conversation_panel(
    lang: Lang,
    panel_id: SharedString,
    questions: Vec<Question>,
    result: &Entity<Option<Vec<Answer>>>,
    state: &Entity<PanelState>,
    cx: &App,
) -> ComposerQuestionPanel {
    let (set_done, set_skip, set_collapse, set_expand) =
        (result.clone(), result.clone(), state.clone(), state.clone());
    let skip_questions = questions.clone();
    ComposerQuestionPanel::new(panel_id, questions, move |answers, _, cx| {
        let answers = answers.to_vec();
        set_done.update(cx, |value, cx| {
            *value = Some(answers);
            cx.notify();
        });
    })
    .placement(Placement::Conversation)
    .labels(labels(lang))
    .state(*state.read(cx))
    .on_skip(move |_, cx| {
        let answers = skip_questions
            .iter()
            .map(|q| Answer::empty(q.id.clone()))
            .collect();
        set_skip.update(cx, |value, cx| {
            *value = Some(answers);
            cx.notify();
        });
    })
    .on_collapse(move |_, cx| {
        set_collapse.update(cx, |value, cx| {
            *value = PanelState::Collapsed;
            cx.notify();
        });
    })
    .on_expand(move |_, cx| {
        set_expand.update(cx, |value, cx| {
            *value = PanelState::Open;
            cx.notify();
        });
    })
}
