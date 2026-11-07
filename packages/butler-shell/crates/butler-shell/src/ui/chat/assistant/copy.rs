//! The strings of the assistant body. Each field names its `packages/butler-i18n` path and has
//! its text; `crate::ui::i18n::Strings` is not extended from this unit.
use butler_ds::ui::context::{Ds, Lang};
use gpui::App;

pub(super) struct Text {
    /// conversation.failure.regionLabel is not drawn; conversation.failure.title
    pub(super) failure_title: &'static str,
    /// conversation.failure.retry, retryCurrent, retrying, fallbackReason
    pub(super) retry: &'static str,
    pub(super) retry_current: &'static str,
    pub(super) retrying: &'static str,
    pub(super) fallback_reason: &'static str,
    /// settings.logs.trace.viewLogs
    pub(super) view_logs: &'static str,
    /// common.more
    pub(super) more: &'static str,
    /// conversation.messageActions.copyMessage, copied
    pub(super) copy_message: &'static str,
    pub(super) copied: &'static str,
    /// interfaceDetails.answerFailed, answerStopped, answerDone
    pub(super) answer_failed: &'static str,
    pub(super) answer_stopped: &'static str,
    pub(super) answer_done: &'static str,
    /// conversation.answerBlocks.preparing, prepared, rechecking
    pub(super) preparing: &'static str,
    pub(super) prepared: &'static str,
    pub(super) rechecking: &'static str,
    /// conversation.incompleteStatus, stoppedStatus, attachmentUnavailable
    pub(super) incomplete: &'static str,
    pub(super) stopped: &'static str,
    pub(super) attachment_unavailable: &'static str,
    /// interfaceStatus.branchChat, branchProject, branchDescription, projectName,
    /// conversationTitle, branchPending, close, retry, create
    pub(super) branch_chat: &'static str,
    pub(super) branch_project: &'static str,
    pub(super) branch_description: &'static str,
    pub(super) project_name: &'static str,
    pub(super) conversation_title: &'static str,
    pub(super) branch_pending: &'static str,
    pub(super) close: &'static str,
    pub(super) try_again: &'static str,
    pub(super) create: &'static str,
    /// interfaceDetails.branchFailed, branchSourceTitle, branchSourceDescription, branchSource,
    /// branchSourceFailed
    pub(super) branch_failed: &'static str,
    pub(super) seed_title: &'static str,
    pub(super) seed_description: &'static str,
    pub(super) seed_open: &'static str,
    pub(super) seed_failed: &'static str,
    worked_for: fn(&str) -> String,
    step: fn(&str, &str) -> String,
    step_epic: fn(&str) -> String,
    work_failed: WorkFailed,
}

struct WorkFailed {
    failed: &'static str,
    retrying: &'static str,
    continuing: &'static str,
    reasons: [(&'static str, &'static str); 4],
}

const EN: Text = Text {
    failure_title: "Butler could not complete the request.",
    retry: "Retry original settings",
    retry_current: "Retry as new with current settings",
    retrying: "Retrying",
    fallback_reason: "No safe error details are available.",
    view_logs: "View logs",
    more: "More",
    copy_message: "Copy message",
    copied: "Copied",
    answer_failed: "Response failed",
    answer_stopped: "Response stopped",
    answer_done: "Response completed",
    preparing: "Preparing answer cards",
    prepared: "Answer cards ready",
    rechecking: "Butler is checking again",
    incomplete: "Incomplete",
    stopped: "Stopped",
    attachment_unavailable: "Attachment unavailable",
    branch_chat: "Start a new conversation",
    branch_project: "Start a new project",
    branch_description: "Continue with a summary of requests and decisions through this response. The original conversation stays unchanged.",
    project_name: "Project name",
    conversation_title: "Conversation title",
    branch_pending: "Summarizing the conversation context.",
    close: "Close",
    try_again: "Try again",
    create: "Create",
    branch_failed: "Could not create a conversation. Try again.",
    seed_title: "Context from the previous conversation",
    seed_description: "A summary through the selected response. The original remains in the source conversation.",
    seed_open: "Go to original response",
    seed_failed: "Could not open the original.",
    worked_for: |duration| format!("Worked for {duration}"),
    step: |plan, epic| {
        format!("Processing task \u{2018}{epic}\u{2019} from plan \u{2018}{plan}\u{2019}.")
    },
    step_epic: |epic| format!("Processing task \u{2018}{epic}\u{2019}."),
    work_failed: WorkFailed {
        failed: "Couldn't deliver the work result",
        retrying: "The work result hasn't been delivered yet",
        continuing: "Still retrying",
        reasons: [
            ("hook_blocked", "A configured rule blocked it"),
            ("session_model_unavailable", "The model isn't available"),
            ("invalid_request", "The request can't be processed"),
            ("unknown_error", "Unknown error"),
        ],
    },
};

const KO: Text = Text {
    failure_title: "응답 처리 중 문제가 발생했습니다.",
    retry: "원래 설정으로 다시 시도",
    retry_current: "현재 설정으로 새로 시도",
    retrying: "다시 시도 중",
    fallback_reason: "안전한 오류 내용을 확인할 수 없습니다.",
    view_logs: "로그 보기",
    more: "더 보기",
    copy_message: "메시지 복사",
    copied: "복사됨",
    answer_failed: "답변 실패",
    answer_stopped: "답변 중지",
    answer_done: "답변 완료",
    preparing: "답변 카드 준비 중",
    prepared: "답변 카드 준비",
    rechecking: "버틀러가 다시 확인하는 중",
    incomplete: "미완료",
    stopped: "중지됨",
    attachment_unavailable: "첨부 파일을 찾을 수 없음",
    branch_chat: "새 주제대화 시작",
    branch_project: "새 프로젝트 시작",
    branch_description: "이 답변까지의 요청과 결정을 정리해 이어갑니다. 원래 대화는 그대로 남습니다.",
    project_name: "프로젝트 이름",
    conversation_title: "대화 제목",
    branch_pending: "대화의 맥락을 정리하고 있습니다.",
    close: "닫기",
    try_again: "다시 시도",
    create: "만들기",
    branch_failed: "새 대화를 만들지 못했습니다. 다시 시도해 주세요.",
    seed_title: "이전 대화에서 이어온 내용",
    seed_description: "선택한 답변까지의 대화를 정리한 내용입니다. 원문은 기존 대화에 보존되어 있습니다.",
    seed_open: "원본 답변으로 이동",
    seed_failed: "원문을 열 수 없습니다.",
    worked_for: |duration| format!("{duration} 동안 작업"),
    step: |plan, epic| {
        format!("계획 \u{2018}{plan}\u{2019}의 과제 \u{2018}{epic}\u{2019}를 처리합니다.")
    },
    step_epic: |epic| format!("과제 \u{2018}{epic}\u{2019}을(를) 처리합니다."),
    work_failed: WorkFailed {
        failed: "작업 결과를 전달하지 못했어요",
        retrying: "작업 결과를 아직 전달하지 못했어요",
        continuing: "계속 다시 시도하고 있어요",
        reasons: [
            ("hook_blocked", "설정된 규칙이 막았어요"),
            ("session_model_unavailable", "모델을 사용할 수 없어요"),
            ("invalid_request", "요청을 처리할 수 없어요"),
            ("unknown_error", "알 수 없는 오류예요"),
        ],
    },
};

/// The strings for the app's language.
pub(super) fn text(cx: &App) -> &'static Text {
    match Ds::get(cx).lang() {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}

impl Text {
    /// interfaceTemplates.workedFor
    pub(super) fn worked_for(&self, duration: &str) -> String {
        (self.worked_for)(duration)
    }

    /// canon.queue.step (with a plan title) and canon.queue.stepEpic
    pub(super) fn canon_step(&self, plan: Option<&str>, epic: &str) -> String {
        match plan.filter(|plan| !plan.is_empty()) {
            Some(plan) => (self.step)(plan, epic),
            None => (self.step_epic)(epic),
        }
    }

    /// conversation.initiated.workFailed (work-failure.ts `workFailureLine`)
    pub(super) fn work_failed(&self, retrying: bool, reason: Option<&str>) -> String {
        let copy = &self.work_failed;
        let code = reason
            .and_then(|code| copy.reasons.iter().find(|(known, _)| *known == code))
            .unwrap_or(&copy.reasons[3]);
        let mut parts = vec![if retrying { copy.retrying } else { copy.failed }];
        if !retrying || code.0 != "unknown_error" {
            parts.push(code.1);
        }
        if retrying {
            parts.push(copy.continuing);
        }
        parts.join(" \u{b7} ")
    }
}
