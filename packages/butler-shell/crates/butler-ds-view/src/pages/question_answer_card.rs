//! QuestionAnswerCard.showcase.tsx: answered, skipped, answered by message and a partial answer,
//! over the onboarding questions of the ComposerQuestionPanel fixtures.
use butler_ds::ui::blocks::question_answer_card::{
    Answer, Labels, Question, QuestionAnswerCard, QuestionKind, Variant,
};
use gpui::{AnyElement, IntoElement as _};

use super::Story;
use crate::copy::Lang;

/// `questionFixtures(ko).onboarding`.
fn onboarding(lang: Lang) -> Vec<Question> {
    let options = |labels: [&'static str; 3]| labels.iter().map(|label| (*label).into()).collect();
    vec![
        Question {
            id: "name".into(),
            header: lang.pick("Name", "호칭").into(),
            kind: QuestionKind::Text,
            options: Vec::new(),
        },
        Question {
            id: "purpose".into(),
            header: lang.pick("Purpose", "주 용도").into(),
            kind: QuestionKind::Single,
            options: options(lang.pick(
                ["Work", "Development", "Personal"],
                ["업무", "개발", "개인"],
            )),
        },
        Question {
            id: "language".into(),
            header: lang.pick("Language", "언어·말투").into(),
            kind: QuestionKind::Single,
            options: options(lang.pick(
                ["Korean · polite", "Korean · casual", "English"],
                ["한국어 · 존댓말", "한국어 · 반말", "English"],
            )),
        },
    ]
}

fn card(lang: Lang, name: &'static str, variant: Variant, partial: bool) -> AnyElement {
    let questions = onboarding(lang);
    let answers = questions
        .iter()
        .enumerate()
        .map(|(index, question)| {
            let text = question.kind == QuestionKind::Text;
            Answer {
                id: question.id.clone(),
                selected: if text { Vec::new() } else { vec![0] },
                text: if text {
                    lang.pick("Alex", "민수").into()
                } else {
                    "".into()
                },
                other: "".into(),
                skipped: partial && index > 0,
            }
        })
        .collect();
    let mut card = QuestionAnswerCard::new(format!("qa-{name}"), questions)
        .variant(variant)
        .answers(answers)
        .message(lang.pick("Please sort my inbox first", "잠깐, 메일부터 정리해줘"));
    if lang == Lang::Ko {
        card = card.labels(Labels {
            answered: "답변 완료".into(),
            skipped: "건너뜀".into(),
            message: "메시지로 답함".into(),
        });
    }
    card.into_any_element()
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "answered",
            render: |lang, _, _| card(lang, "answered", Variant::Answered, false),
        },
        Story {
            name: "skipped",
            render: |lang, _, _| card(lang, "skipped", Variant::Skipped, false),
        },
        Story {
            name: "message",
            render: |lang, _, _| card(lang, "message", Variant::Message, false),
        },
        Story {
            name: "partial",
            render: |lang, _, _| card(lang, "partial", Variant::Answered, true),
        },
    ]
}
