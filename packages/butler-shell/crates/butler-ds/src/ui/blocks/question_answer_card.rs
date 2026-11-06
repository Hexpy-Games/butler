//! DS QuestionAnswerCard (QuestionAnswerCard.tsx): a completed answer on the user side of the
//! transcript; it never executes a tool. Each question shows its header and the answer's text, or
//! the skipped label.
use gpui::{App, ElementId, IntoElement, ParentElement, RenderOnce, SharedString, Window};

use super::message_row::{MessageRow, Role};
use crate::ui::layout::{Space, Stack};
use crate::ui::typo::{Tone, Typo, Wrap};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QuestionKind {
    Single,
    Multi,
    Text,
}

/// A question of a `ComposerQuestionPanel` (`ComposerQuestion`): what the card needs of it.
#[derive(Clone, Debug)]
pub struct Question {
    pub id: SharedString,
    pub header: SharedString,
    pub kind: QuestionKind,
    pub options: Vec<SharedString>,
}

/// The answer to a question (`QuestionAnswer`).
#[derive(Clone, Debug, Default)]
pub struct Answer {
    pub id: SharedString,
    pub selected: Vec<usize>,
    pub text: SharedString,
    pub other: SharedString,
    pub skipped: bool,
}

/// `answerText`: the chosen option labels, then the typed text, then the "other" text, joined by
/// commas; empty for a skipped or missing answer.
pub fn answer_text(question: &Question, answer: Option<&Answer>) -> String {
    let Some(answer) = answer.filter(|answer| !answer.skipped) else {
        return String::new();
    };
    answer
        .selected
        .iter()
        .filter_map(|index| question.options.get(*index).map(ToString::to_string))
        .chain([
            answer.text.trim().to_owned(),
            answer.other.trim().to_owned(),
        ])
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(", ")
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Variant {
    #[default]
    Answered,
    Skipped,
    Message,
}

/// The three labels a card shows: answered, skipped and answered-by-message.
#[derive(Clone, Debug)]
pub struct Labels {
    pub answered: SharedString,
    pub skipped: SharedString,
    pub message: SharedString,
}

impl Default for Labels {
    fn default() -> Self {
        Self {
            answered: "Answered".into(),
            skipped: "Skipped".into(),
            message: "Answered by message".into(),
        }
    }
}

#[derive(IntoElement)]
pub struct QuestionAnswerCard {
    id: ElementId,
    questions: Vec<Question>,
    answers: Vec<Answer>,
    variant: Variant,
    message: Option<SharedString>,
    labels: Labels,
}

impl QuestionAnswerCard {
    pub fn new(id: impl Into<ElementId>, questions: Vec<Question>) -> Self {
        Self {
            id: id.into(),
            questions,
            answers: Vec::new(),
            variant: Variant::Answered,
            message: None,
            labels: Labels::default(),
        }
    }

    pub fn answers(mut self, answers: Vec<Answer>) -> Self {
        self.answers = answers;
        self
    }

    pub fn variant(mut self, variant: Variant) -> Self {
        self.variant = variant;
        self
    }

    /// The text of a `Message` card.
    pub fn message(mut self, message: impl Into<SharedString>) -> Self {
        self.message = Some(message.into());
        self
    }

    pub fn labels(mut self, labels: Labels) -> Self {
        self.labels = labels;
        self
    }
}

impl RenderOnce for QuestionAnswerCard {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        let label = match self.variant {
            Variant::Answered => self.labels.answered.clone(),
            Variant::Skipped => self.labels.skipped.clone(),
            Variant::Message => self.labels.message.clone(),
        };
        let mut body = Stack::new()
            .gap(Space::Sm)
            .child(Typo::caption(label).tone(Tone::Tertiary));
        match self.variant {
            Variant::Message => {
                body =
                    body.child(Typo::text(self.message.unwrap_or_default()).wrap(Wrap::Anywhere));
            }
            _ => {
                for question in &self.questions {
                    let shown = match self.variant {
                        Variant::Skipped => String::new(),
                        _ => answer_text(
                            question,
                            self.answers.iter().find(|answer| answer.id == question.id),
                        ),
                    };
                    let shown = if shown.is_empty() {
                        self.labels.skipped.to_string()
                    } else {
                        shown
                    };
                    body = body.child(
                        Stack::new()
                            .gap(Space::None)
                            .child(Typo::caption(question.header.clone()).tone(Tone::Tertiary))
                            .child(Typo::label(shown).wrap(Wrap::Anywhere)),
                    );
                }
            }
        }
        MessageRow::new(self.id, Role::User).child(body)
    }
}
