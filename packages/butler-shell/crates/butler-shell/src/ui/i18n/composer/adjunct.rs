//! The composer's work progress and worker panels' copy.
use butler_ds::ui::context::Lang;

/// The `conversation.work`, `inspector.tabs`, `interfaceFeedback` and `interfaceTemplates`
/// strings these panels read.
pub(crate) struct Words {
    pub(crate) todo_title: &'static str,
    pub(crate) pending: &'static str,
    pub(crate) running: &'static str,
    pub(crate) completed: &'static str,
    pub(crate) reviewing: &'static str,
    pub(crate) correction: &'static str,
    pub(crate) blocked: &'static str,
    pub(crate) skipped: &'static str,
    pub(crate) stopped: &'static str,
    pub(crate) workers: &'static str,
    /// `interfaceFeedback`: thinking, planning, inspecting, executing, verifying, committing,
    /// consolidating, reporting, complete, recoverable.
    pub(crate) phases: [&'static str; 10],
}

static KO: Words = Words {
    todo_title: "진행 단계",
    pending: "대기",
    running: "진행 중",
    completed: "완료",
    reviewing: "검토 중",
    correction: "수정 필요",
    blocked: "막힘",
    skipped: "건너뜀",
    stopped: "중지됨",
    workers: "작업자",
    phases: [
        "생각 중",
        "계획 중",
        "확인 중",
        "실행 중",
        "검증 중",
        "커밋 중",
        "정리 중",
        "보고 중",
        "완료",
        "재개 가능",
    ],
};

static EN: Words = Words {
    todo_title: "Steps",
    pending: "Pending",
    running: "In progress",
    completed: "Done",
    reviewing: "Reviewing",
    correction: "Correction required",
    blocked: "Blocked",
    skipped: "Skipped",
    stopped: "Stopped",
    workers: "Workers",
    phases: [
        "Thinking",
        "Planning",
        "Inspecting",
        "Executing",
        "Verifying",
        "Committing",
        "Consolidating",
        "Reporting",
        "Complete",
        "Recoverable",
    ],
};

pub(crate) fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}

/// `interfaceTemplates.more`.
pub(crate) fn more(lang: Lang, title: &str, count: usize) -> String {
    match lang {
        Lang::Ko => format!("{title} 외 {count}개"),
        Lang::En => format!("{title} and {count} more"),
    }
}
