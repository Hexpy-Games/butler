//! The copy of the question panel (`useComposerQuestion`). Each field names its
//! `packages/butler-i18n` key.
use butler_ds::ui::blocks::composer_question_panel::Labels;
use butler_ds::ui::context::{Ds, Lang};
use gpui::App;

pub(crate) struct QuestionCopy {
    /// interfaceDetails.questionPanel: review, send, next, back, skip, skipped, later, pending,
    /// other, recommended, working, select
    labels: [&'static str; 12],
    /// interfaceDetails.decisionFailed
    pub(crate) decision_failed: &'static str,
}

const KO: QuestionCopy = QuestionCopy {
    labels: [
        "검토",
        "보내기",
        "다음",
        "이전",
        "건너뛰기",
        "건너뜀",
        "나중에 답하기",
        "답변 대기",
        "직접 입력…",
        "추천",
        "진행 중",
        "선택",
    ],
    decision_failed: "결정을 전달하지 못했습니다.",
};

const EN: QuestionCopy = QuestionCopy {
    labels: [
        "Review",
        "Send",
        "Next",
        "Back",
        "Skip",
        "Skipped",
        "Answer later",
        "Answer pending",
        "Other…",
        "Recommended",
        "Working",
        "Select",
    ],
    decision_failed: "Could not submit the decision. Try again.",
};

impl QuestionCopy {
    pub(crate) fn of(lang: Lang) -> &'static Self {
        match lang {
            Lang::Ko => &KO,
            Lang::En => &EN,
        }
    }

    /// The copy of the app language.
    pub(crate) fn get(cx: &App) -> &'static Self {
        Self::of(Ds::get(cx).lang())
    }

    /// `appCopy.interfaceDetails.questionPanel`.
    pub(crate) fn labels(&self) -> Labels {
        let [review, send, next, back, skip, skipped, later, pending, other, recommended, working, select] =
            self.labels.map(gpui::SharedString::new_static);
        Labels {
            review,
            send,
            next,
            back,
            skip,
            skipped,
            later,
            pending,
            other,
            recommended,
            working,
            select,
        }
    }
}
