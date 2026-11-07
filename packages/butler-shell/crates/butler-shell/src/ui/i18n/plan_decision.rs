//! The plan decision's copy. Each field names its `packages/butler-i18n` key.
use butler_ds::ui::context::Lang;

pub(crate) struct Words {
    /// composer.plan
    pub(crate) plan: &'static str,
    /// composer.planInstruction
    pub(crate) instruction: &'static str,
    /// composer.planReject
    pub(crate) reject: &'static str,
    /// composer.planAccept
    pub(crate) accept: &'static str,
    /// composer.planInstructionPlaceholder
    pub(crate) instruction_placeholder: &'static str,
    /// composer.planInstructionActive
    pub(crate) instruction_active: &'static str,
    /// interfaceFeedback.planDecisionFailed
    pub(crate) decision_failed: &'static str,
}

static KO: Words = Words {
    plan: "계획",
    instruction: "직접 입력",
    reject: "거절",
    accept: "수락",
    instruction_placeholder: "수정할 내용을 직접 입력하세요",
    instruction_active: "계획 수정 중",
    decision_failed: "계획 결정 전달 실패",
};

static EN: Words = Words {
    plan: "Plan",
    instruction: "Write feedback",
    reject: "Reject",
    accept: "Accept",
    instruction_placeholder: "Describe the change you want",
    instruction_active: "Revising plan",
    decision_failed: "Plan decision failed",
};

pub(crate) fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}
