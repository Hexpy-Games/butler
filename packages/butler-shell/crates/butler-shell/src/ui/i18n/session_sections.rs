//! The copy of the session info inspector's sections, pending asks and subtasks. Each field
//! names its `packages/butler-i18n` key.
use butler_ds::ui::context::{Ds, Lang};
use gpui::App;

pub(crate) struct SessionSections {
    /// sessionInfo.asks, subtasks, order
    pub(crate) asks: &'static str,
    pub(crate) subtasks: &'static str,
    pub(crate) order: &'static str,
    /// sessionInfo.environment, folder, branch, context, attachments
    pub(crate) environment: &'static str,
    pub(crate) folder: &'static str,
    pub(crate) branch: &'static str,
    pub(crate) context: &'static str,
    pub(crate) attachments: &'static str,
    /// sessionInfo.approval, question, deferred
    pub(crate) approval: &'static str,
    pub(crate) question: &'static str,
    pub(crate) deferred: &'static str,
    /// canon.epic
    pub(crate) epic: &'static str,
    /// sessionInfo.subtaskPaused, subtaskNeedsApproval; space.working
    pub(crate) subtask_paused: &'static str,
    pub(crate) subtask_needs_approval: &'static str,
    pub(crate) working: &'static str,
    /// conversation.work.resumeInterrupted
    pub(crate) resume: &'static str,
    /// interfaceFeedback.stewardResumeFailed
    pub(crate) resume_failed: &'static str,
    /// guided.workerStatus: executing, waiting, complete, failed, blocked, cancelled
    pub(crate) worker_executing: &'static str,
    pub(crate) worker_waiting: &'static str,
    pub(crate) worker_complete: &'static str,
    pub(crate) worker_failed: &'static str,
    pub(crate) worker_blocked: &'static str,
    pub(crate) worker_cancelled: &'static str,
}

const KO: SessionSections = SessionSections {
    asks: "답을 기다리는 요청",
    subtasks: "하위 작업",
    order: "진행 순서",
    environment: "환경",
    folder: "작업 폴더",
    branch: "브랜치",
    context: "컨텍스트",
    attachments: "첨부",
    approval: "승인",
    question: "질문",
    deferred: "나중에 답하기로 함",
    epic: "과제",
    subtask_paused: "멈춤",
    subtask_needs_approval: "허용 대기",
    working: "작업 중",
    resume: "이어서 진행",
    resume_failed: "하위 작업 재개 실패",
    worker_executing: "작업 중",
    worker_waiting: "대기",
    worker_complete: "완료",
    worker_failed: "실패",
    worker_blocked: "진행이 막힘",
    worker_cancelled: "취소됨",
};

const EN: SessionSections = SessionSections {
    asks: "Awaiting your answer",
    subtasks: "Subtasks",
    order: "Run order",
    environment: "Environment",
    folder: "Working folder",
    branch: "Branch",
    context: "Context",
    attachments: "Attachments",
    approval: "Approval",
    question: "Question",
    deferred: "Deferred",
    epic: "Epic",
    subtask_paused: "Paused",
    subtask_needs_approval: "Needs approval",
    working: "Working",
    resume: "Resume",
    resume_failed: "Subtask resume failed",
    worker_executing: "Working",
    worker_waiting: "Waiting",
    worker_complete: "Complete",
    worker_failed: "Failed",
    worker_blocked: "Blocked",
    worker_cancelled: "Cancelled",
};

impl SessionSections {
    /// The copy of `lang`.
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
}
